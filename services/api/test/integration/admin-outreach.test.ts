/**
 * Outreach pipeline data-layer integration test (Docker-gated). Exercises the REAL Drizzle/raw-SQL
 * OutreachRepository (makeDrizzleOutreachRepository) + the OutreachService end-to-end against a live
 * Postgres container via withPg, which applies the canonical migrations + the jurisdiction seed (so
 * reports / jurisdiction_contacts / jurisdictions / mail_* / outreach_state all exist with their real
 * constraints + FKs).
 *
 * Proven here against the real schema:
 *   - loadDigest aggregates a geoid's waiting reports per category + resolves the routing recipient
 *     (jurisdiction_contacts default -> per-category -> legacy contact_emails[]), returning null when
 *     there is nothing to send;
 *   - listCandidateGeoids returns geoids with BOTH waiting reports and a usable contact;
 *   - runForGeoid sends ONE digest via the (Fake) Mailer, records the out mail_threads/mail_messages +
 *     a 'sent' mail_events row, and stamps outreach_state.last_outreach_at;
 *   - the throttle window (outreach_state.last_outreach_at + throttleDays) prevents a re-send.
 *
 * When Docker is unavailable the whole describe block SKIPS (describe.skipIf), so the local suite stays
 * green; CI runs it for real. Reuses withPg() per the harness contract.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { FakeMailer } from "@civfix/shared/fakes"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { makeDrizzleMailRepository } from "../../src/services/admin/mail-repository.drizzle.js"
import { makeDrizzleOutreachRepository } from "../../src/services/admin/outreach-repository.drizzle.js"
import { makeOutboundMailService } from "../../src/services/admin/outbound-mail-service.js"
import { makeOutreachService } from "../../src/services/admin/outreach-service.js"
import { LA_CITY } from "../../src/db/seed-fixtures.js"

const pg = await withPg()

const GEOID = LA_CITY.geoid
const NOW = new Date("2026-06-06T00:00:00.000Z")
const THROTTLE_DAYS = 7

/** Insert a report in the seeded jurisdiction. */
async function insertReport(
  h: PgHarness,
  opts: { category: string; status?: string },
): Promise<void> {
  await h.sql`
    INSERT INTO reports (idempotency_key, geom, geom_source, category, status, h3_cell, jurisdiction_geoid)
    VALUES (
      gen_random_uuid(),
      ST_SetSRID(ST_MakePoint(-118.35, 34.1), 4326),
      'manual',
      ${opts.category},
      ${opts.status ?? "submitted"},
      'h0',
      ${GEOID}
    )
  `
}

/** Upsert a routing contact for the seeded jurisdiction (category NULL = default). */
async function setContact(h: PgHarness, email: string): Promise<void> {
  await h.sql`
    INSERT INTO jurisdiction_contacts (geoid, category, email, updated_at)
    VALUES (${GEOID}, NULL, ${email}, now())
    ON CONFLICT (geoid) WHERE category IS NULL
    DO UPDATE SET email = EXCLUDED.email, updated_at = now()
  `
}

describe.skipIf(!pg)("outreach pipeline (integration: real schema)", () => {
  let h: PgHarness

  beforeAll(() => {
    h = pg as PgHarness
  })

  beforeEach(async () => {
    await h.sql`TRUNCATE mail_events, mail_messages, mail_threads, outreach_state RESTART IDENTITY CASCADE`
    await h.sql`DELETE FROM jurisdiction_contacts`
    await h.sql`DELETE FROM reports`
    await h.sql`UPDATE jurisdictions SET contact_emails = NULL, report_form_url = NULL`
  })

  afterAll(async () => {
    await h.teardown()
  })

  function service(mailer: FakeMailer) {
    const mailRepo = makeDrizzleMailRepository(h.sql)
    const outboundMail = makeOutboundMailService({
      repo: mailRepo,
      mailer,
      env: { MAIL_FROM_OUTREACH: "outreach@civfix.org", MAIL_REPLY_DOMAIN: "civfix.org" },
    })
    return makeOutreachService({
      outreachRepo: makeDrizzleOutreachRepository(h.sql),
      mailRepo,
      outboundMail,
      throttleDays: THROTTLE_DAYS,
      now: () => NOW,
    })
  }

  it("loadDigest aggregates waiting reports + resolves the contact (null when nothing to send)", async () => {
    const repo = makeDrizzleOutreachRepository(h.sql)
    expect(await repo.loadDigest(GEOID)).toBeNull() // no reports, no contact

    await insertReport(h, { category: "trash" })
    await insertReport(h, { category: "trash" })
    await insertReport(h, { category: "hazard" })
    await insertReport(h, { category: "other", status: "resolved" }) // not waiting
    // Still null: waiting reports but no contact.
    expect(await repo.loadDigest(GEOID)).toBeNull()

    await setContact(h, "clerk@lacity.gov")
    const digest = await repo.loadDigest(GEOID)
    expect(digest?.toAddr).toBe("clerk@lacity.gov")
    expect(digest?.total).toBe(3)
    expect(digest?.perCategory.trash).toBe(2)
    expect(digest?.perCategory.hazard).toBe(1)
  })

  it("listCandidateGeoids includes a geoid only with both waiting reports AND a contact", async () => {
    const repo = makeDrizzleOutreachRepository(h.sql)
    expect(await repo.listCandidateGeoids()).not.toContain(GEOID)
    await insertReport(h, { category: "trash" })
    expect(await repo.listCandidateGeoids()).not.toContain(GEOID) // no contact yet
    await setContact(h, "clerk@lacity.gov")
    expect(await repo.listCandidateGeoids()).toContain(GEOID)
  })

  it("runForGeoid sends one digest, records the out thread/message + 'sent' event, stamps outreach_state", async () => {
    await insertReport(h, { category: "trash" })
    await insertReport(h, { category: "hazard" })
    await setContact(h, "clerk@lacity.gov")
    const mailer = new FakeMailer()

    const result = await service(mailer).runForGeoid(GEOID)
    expect(result.sent).toBe(true)
    expect(result.reportCount).toBe(2)
    expect(mailer.sent).toHaveLength(1)
    expect(mailer.sent[0]?.to).toBe("clerk@lacity.gov")

    const threads = await h.sql<{ id: string }[]>`SELECT id FROM mail_threads WHERE jurisdiction_geoid = ${GEOID}`
    expect(threads).toHaveLength(1)
    const messages = await h.sql<{ direction: string }[]>`SELECT direction FROM mail_messages`
    expect(messages).toHaveLength(1)
    expect(messages[0]?.direction).toBe("out")
    const events = await h.sql<{ type: string }[]>`SELECT type FROM mail_events`
    expect(events.some((e) => e.type === "sent")).toBe(true)
    const state = await h.sql<{ last_outreach_at: Date | null }[]>`
      SELECT last_outreach_at FROM outreach_state WHERE geoid = ${GEOID}
    `
    expect(state[0]?.last_outreach_at).not.toBeNull()
  })

  it("does NOT re-send inside the throttle window", async () => {
    await insertReport(h, { category: "trash" })
    await setContact(h, "clerk@lacity.gov")
    // Seed a recent outreach (1 day ago, inside the 7-day window).
    await h.sql`
      INSERT INTO outreach_state (geoid, last_outreach_at)
      VALUES (${GEOID}, ${new Date(NOW.getTime() - 24 * 60 * 60 * 1000)})
    `
    const mailer = new FakeMailer()
    const result = await service(mailer).runForGeoid(GEOID)
    expect(result.sent).toBe(false)
    expect(result.skipped).toBe("throttled")
    expect(mailer.sent).toHaveLength(0)
  })
})
