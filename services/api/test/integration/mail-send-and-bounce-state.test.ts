import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { makeDrizzleMailRepository } from "../../src/services/admin/mail-repository.drizzle.js"
import { makeDrizzleOutreachRepository } from "../../src/services/admin/outreach-repository.drizzle.js"
import { ROUTE_CLAIM_STALE_SECONDS } from "../../src/services/admin/outbound-send-policy.js"
import { LA_CITY } from "../../src/db/seed-fixtures.js"

const pg = await withPg()

describe.skipIf(!pg)("mail send + bounce state against real SQL", () => {
  let h: PgHarness
  let mail: ReturnType<typeof makeDrizzleMailRepository>

  beforeAll(() => {
    h = pg as PgHarness
    mail = makeDrizzleMailRepository(h.sql)
  })

  beforeEach(async () => {
    await h.sql`TRUNCATE mail_events, mail_messages, mail_threads RESTART IDENTITY CASCADE`
  })

  afterAll(async () => {
    await h.teardown()
  })

  async function outbound(): Promise<{ threadId: string; messageId: string }> {
    const thread = await mail.upsertThreadByGeoid(LA_CITY.geoid, { subject: "Digest" })
    const message = await mail.insertMessage({
      threadId: thread.id,
      direction: "out",
      fromAddr: "outreach@civfix.org",
      toAddr: "clerk@lacity.gov",
      body: "digest",
    })
    return { threadId: thread.id, messageId: message!.id }
  }

  it("treats a young attempt with no outcome yet as in flight, and a stale one as not", async () => {
    const { threadId, messageId } = await outbound()
    expect(await mail.hasSendInFlight(threadId)).toBe(true)

    await h.sql`
      UPDATE mail_messages SET created_at = now() - make_interval(secs => ${ROUTE_CLAIM_STALE_SECONDS + 60})
      WHERE id = ${messageId}
    `
    expect(await mail.hasSendInFlight(threadId)).toBe(false)
  })

  it("stops reporting in flight once the attempt records sent or a hard failure", async () => {
    const sent = await outbound()
    await mail.recordEvent({ threadId: sent.threadId, messageId: sent.messageId, type: "sent" })
    expect(await mail.hasSendInFlight(sent.threadId)).toBe(false)
  })

  it("finds a recorded bounce by thread, original Message-ID and recipient (any case)", async () => {
    const { threadId } = await outbound()
    const key = {
      threadId,
      failedRecipient: "Clerk@LACity.gov",
      originalMessageId: "<out-1@civfix.org>",
    }
    expect(await mail.bounceEventState(key)).toBe("none")
    await mail.recordEvent({
      threadId,
      type: "bounced",
      meta: { failedRecipient: "clerk@lacity.gov", originalMessageId: "<out-1@civfix.org>" },
    })
    expect(await mail.bounceEventState(key)).toBe("complete")
    expect(await mail.bounceEventState({ ...key, originalMessageId: "<out-2@civfix.org>" })).toBe(
      "none",
    )
  })

  it("keeps a bounce pending until its discovery enqueue is marked", async () => {
    const { threadId } = await outbound()
    const key = {
      threadId,
      failedRecipient: "clerk@lacity.gov",
      originalMessageId: "<out-1@civfix.org>",
    }
    await mail.recordEvent({
      threadId,
      type: "bounced",
      meta: {
        failedRecipient: "clerk@lacity.gov",
        originalMessageId: "<out-1@civfix.org>",
        discoveryPending: true,
      },
    })
    expect(await mail.bounceEventState(key)).toBe("discovery_pending")
    await mail.markBounceDiscoveryEnqueued(key)
    expect(await mail.bounceEventState(key)).toBe("complete")
  })

  it("never picks a legacy contact_emails address that bounced since the last contact save", async () => {
    await h.sql`DELETE FROM jurisdiction_contacts WHERE geoid = ${LA_CITY.geoid}`
    await h.sql`
      UPDATE jurisdictions SET contact_emails = ARRAY['clerk@lacity.gov'], contact_updated_at = NULL
      WHERE geoid = ${LA_CITY.geoid}
    `
    await h.sql`
      INSERT INTO reports (idempotency_key, title, geom, geom_source, category, status, h3_cell, jurisdiction_geoid)
      VALUES (gen_random_uuid(), 'legacy-bounce', ST_SetSRID(ST_MakePoint(-118.25, 34.05), 4326), 'gps',
              'graffiti', 'published', '8a2a1072b59ffff', ${LA_CITY.geoid})
    `
    const outreach = makeDrizzleOutreachRepository(h.sql)
    expect((await outreach.loadDigest(LA_CITY.geoid))?.toAddr).toBe("clerk@lacity.gov")

    const { threadId } = await outbound()
    await mail.recordEvent({
      threadId,
      type: "bounced",
      meta: { failedRecipient: "CLERK@lacity.gov", originalMessageId: "<out-1@civfix.org>" },
    })
    expect(await outreach.loadDigest(LA_CITY.geoid)).toBeNull()
    expect(await outreach.listCandidateGeoids(10)).not.toContain(LA_CITY.geoid)
  })
})
