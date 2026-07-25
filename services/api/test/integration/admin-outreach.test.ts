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
 *   - the throttle window (outreach_state.last_outreach_at + throttleDays) prevents a re-send;
 *   - setOutreachState's OMITTED-vs-EXPLICIT-NULL semantics, and the claim RELEASE that depends on them.
 *     Both need a real Postgres: the clear was folded into a `COALESCE`, which cannot tell "keep" from
 *     "clear", so the reset silently no-op'd against the database while passing against the in-memory repo,
 *     which has always distinguished them. A unit test could not have caught it and cannot guard it.
 *
 * When Docker is unavailable the whole describe block SKIPS (describe.skipIf), so the local suite stays
 * green; CI runs it for real. Reuses withPg() per the harness contract.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { FakeMailer } from "@civfix/shared/fakes"
import type { OutboundEmail } from "@civfix/shared/interfaces"
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

  /** Read outreach_state straight out of Postgres (the fake cannot be wrong about this). */
  async function storedState(): Promise<{ last_outreach_at: Date | null; suppressed: boolean } | undefined> {
    const rows = await h.sql<{ last_outreach_at: Date | null; suppressed: boolean }[]>`
      SELECT last_outreach_at, suppressed FROM outreach_state WHERE geoid = ${GEOID}
    `
    return rows[0]
  }

  describe("setOutreachState: OMITTED keeps, explicit NULL clears", () => {
    it("an explicit {lastOutreachAt: null} CLEARS the stored timestamp", async () => {
      const repo = makeDrizzleMailRepository(h.sql)
      const stamped = new Date(NOW.getTime() - 24 * 60 * 60 * 1000)
      await repo.setOutreachState(GEOID, { lastOutreachAt: stamped })
      expect((await storedState())?.last_outreach_at?.getTime()).toBe(stamped.getTime())

      // The bug: folded into COALESCE, this was indistinguishable from "omitted" and kept the old value.
      const cleared = await repo.setOutreachState(GEOID, { lastOutreachAt: null })
      expect(cleared.lastOutreachAt).toBeNull()
      expect((await storedState())?.last_outreach_at).toBeNull()
    })

    it("an OMITTED lastOutreachAt keeps the stored timestamp (and vice versa for suppressed)", async () => {
      const repo = makeDrizzleMailRepository(h.sql)
      const stamped = new Date(NOW.getTime() - 24 * 60 * 60 * 1000)
      await repo.setOutreachState(GEOID, { lastOutreachAt: stamped, suppressed: true })

      // Patch ONLY suppressed: the timestamp must survive.
      const kept = await repo.setOutreachState(GEOID, { suppressed: false })
      expect(kept.lastOutreachAt?.getTime()).toBe(stamped.getTime())
      expect(kept.suppressed).toBe(false)
      const afterKeep = await storedState()
      expect(afterKeep?.last_outreach_at?.getTime()).toBe(stamped.getTime())
      expect(afterKeep?.suppressed).toBe(false)

      // Patch ONLY the timestamp (to null): suppressed must survive.
      await repo.setOutreachState(GEOID, { suppressed: true })
      const clearedTs = await repo.setOutreachState(GEOID, { lastOutreachAt: null })
      expect(clearedTs.lastOutreachAt).toBeNull()
      expect(clearedTs.suppressed).toBe(true)
      const afterClear = await storedState()
      expect(afterClear?.last_outreach_at).toBeNull()
      expect(afterClear?.suppressed).toBe(true)
    })

    it("inserts the row on first write when there is no outreach_state yet", async () => {
      const repo = makeDrizzleMailRepository(h.sql)
      expect(await storedState()).toBeUndefined()
      await repo.setOutreachState(GEOID, { lastOutreachAt: null })
      const row = await storedState()
      expect(row).toBeDefined()
      expect(row?.last_outreach_at).toBeNull()
      expect(row?.suppressed).toBe(false)
    })
  })

  describe("claimOutreachWindow + release against the real schema", () => {
    /** A mailer that rejects its first `failures` sends, then behaves normally. */
    class FlakyMailer extends FakeMailer {
      failures = 0
      override sendOutbound(email: OutboundEmail): Promise<{ messageId: string }> {
        if (this.failures > 0) {
          this.failures -= 1
          return Promise.reject(new Error("OCI mail transient 500"))
        }
        return super.sendOutbound(email)
      }
    }

    /**
     * The claim, narrowed to non-optional. It is optional on the SEAM (so a fake may decline it), but the
     * Drizzle repo always implements it — asserting that here is itself part of the contract.
     */
    function drizzleClaim(): (
      geoid: string,
      window: { at: Date; windowStart: Date },
    ) => Promise<boolean> {
      const claim = makeDrizzleOutreachRepository(h.sql).claimOutreachWindow
      expect(claim, "the Drizzle outreach repo must implement claimOutreachWindow").toBeDefined()
      return claim as (geoid: string, window: { at: Date; windowStart: Date }) => Promise<boolean>
    }

    it("is exclusive: a second claim inside the window loses without re-stamping", async () => {
      const claim = drizzleClaim()
      const windowStart = new Date(NOW.getTime() - THROTTLE_DAYS * 24 * 60 * 60 * 1000)
      expect(await claim(GEOID, { at: NOW, windowStart })).toBe(true)
      expect(await claim(GEOID, { at: new Date(NOW.getTime() + 1000), windowStart })).toBe(false)
      expect((await storedState())?.last_outreach_at?.getTime()).toBe(NOW.getTime())
    })

    it("never claims a suppressed jurisdiction", async () => {
      const claim = drizzleClaim()
      await h.sql`
        INSERT INTO outreach_state (geoid, last_outreach_at, suppressed)
        VALUES (${GEOID}, NULL, true)
      `
      const won = await claim(GEOID, {
        at: NOW,
        windowStart: new Date(NOW.getTime() - THROTTLE_DAYS * 24 * 60 * 60 * 1000),
      })
      expect(won).toBe(false)
      expect((await storedState())?.last_outreach_at).toBeNull()
    })

    it("RELEASES the claim when the send fails, so the next tick retries (end to end)", async () => {
      await insertReport(h, { category: "trash" })
      await setContact(h, "clerk@lacity.gov")
      const mailer = new FlakyMailer()
      mailer.failures = 1

      await expect(service(mailer).runForGeoid(GEOID)).rejects.toThrow("OCI mail transient 500")
      // The claim stamped last_outreach_at BEFORE the send; the release must have cleared it back to NULL.
      // With the COALESCE bug the release was a silent no-op and this row still read NOW — the jurisdiction
      // then got no digest for the whole 7-day window.
      expect((await storedState())?.last_outreach_at).toBeNull()
      const failedEvents = await h.sql<{ type: string }[]>`SELECT type FROM mail_events`
      expect(failedEvents.map((e) => e.type)).toEqual(["failed"])

      // The retry really goes out.
      const retry = await service(new FakeMailer()).runForGeoid(GEOID)
      expect(retry.sent).toBe(true)
      expect((await storedState())?.last_outreach_at?.getTime()).toBe(NOW.getTime())
    })

    it("a released claim preserves a PRIOR timestamp rather than clearing it", async () => {
      await insertReport(h, { category: "trash" })
      await setContact(h, "clerk@lacity.gov")
      const prior = new Date(NOW.getTime() - (THROTTLE_DAYS + 2) * 24 * 60 * 60 * 1000)
      await h.sql`INSERT INTO outreach_state (geoid, last_outreach_at) VALUES (${GEOID}, ${prior})`
      const mailer = new FlakyMailer()
      mailer.failures = 1

      await expect(service(mailer).runForGeoid(GEOID)).rejects.toThrow("OCI mail transient 500")
      expect((await storedState())?.last_outreach_at?.getTime()).toBe(prior.getTime())
    })
  })
})
