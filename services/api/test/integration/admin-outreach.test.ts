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
    expect(await repo.loadDigest(GEOID)).toBeNull()

    await insertReport(h, { category: "trash" })
    await insertReport(h, { category: "trash" })
    await insertReport(h, { category: "hazard" })
    await insertReport(h, { category: "other", status: "resolved" })
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
    expect(await repo.listCandidateGeoids()).not.toContain(GEOID)
    await setContact(h, "clerk@lacity.gov")
    expect(await repo.listCandidateGeoids()).toContain(GEOID)
  })

  describe("F107: a hard-bounced contact is excluded from every send path", () => {
    async function markBounced(email: string): Promise<void> {
      await h.sql`UPDATE jurisdiction_contacts SET bounced_at = now() WHERE email = ${email}`
    }

    it("loadDigest does NOT resolve a bounced default contact", async () => {
      const repo = makeDrizzleOutreachRepository(h.sql)
      await insertReport(h, { category: "trash" })
      await setContact(h, "clerk@lacity.gov")
      await markBounced("clerk@lacity.gov")
      expect(await repo.loadDigest(GEOID)).toBeNull()
    })

    it("loadDigest falls through to a non-bounced per-category contact when the default bounced", async () => {
      const repo = makeDrizzleOutreachRepository(h.sql)
      await insertReport(h, { category: "trash" })
      await setContact(h, "clerk@lacity.gov")
      await markBounced("clerk@lacity.gov")
      await h.sql`
        INSERT INTO jurisdiction_contacts (geoid, category, email, updated_at)
        VALUES (${GEOID}, 'trash', 'sanitation@lacity.gov', now())
      `
      const digest = await repo.loadDigest(GEOID)
      expect(digest?.toAddr).toBe("sanitation@lacity.gov")
    })

    it("listCandidateGeoids drops a geoid whose only contact is bounced", async () => {
      const repo = makeDrizzleOutreachRepository(h.sql)
      await insertReport(h, { category: "trash" })
      await setContact(h, "clerk@lacity.gov")
      expect(await repo.listCandidateGeoids()).toContain(GEOID)
      await markBounced("clerk@lacity.gov")
      expect(await repo.listCandidateGeoids()).not.toContain(GEOID)
    })
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

    const threads = await h.sql<
      { id: string }[]
    >`SELECT id FROM mail_threads WHERE jurisdiction_geoid = ${GEOID}`
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

  async function storedState(): Promise<
    { last_outreach_at: Date | null; suppressed: boolean } | undefined
  > {
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

      const cleared = await repo.setOutreachState(GEOID, { lastOutreachAt: null })
      expect(cleared.lastOutreachAt).toBeNull()
      expect((await storedState())?.last_outreach_at).toBeNull()
    })

    it("an OMITTED lastOutreachAt keeps the stored timestamp (and vice versa for suppressed)", async () => {
      const repo = makeDrizzleMailRepository(h.sql)
      const stamped = new Date(NOW.getTime() - 24 * 60 * 60 * 1000)
      await repo.setOutreachState(GEOID, { lastOutreachAt: stamped, suppressed: true })

      const kept = await repo.setOutreachState(GEOID, { suppressed: false })
      expect(kept.lastOutreachAt?.getTime()).toBe(stamped.getTime())
      expect(kept.suppressed).toBe(false)
      const afterKeep = await storedState()
      expect(afterKeep?.last_outreach_at?.getTime()).toBe(stamped.getTime())
      expect(afterKeep?.suppressed).toBe(false)

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
      expect((await storedState())?.last_outreach_at).toBeNull()
      const failedEvents = await h.sql<{ type: string }[]>`SELECT type FROM mail_events`
      expect(failedEvents.map((e) => e.type)).toEqual(["failed"])

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
