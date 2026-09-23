import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { InboxFeedResponseSchema, type InboxFeedQuery } from "@civfix/shared"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { LA_CITY } from "../../src/db/seed-fixtures.js"
import { makeDrizzleInboundRepository } from "../../src/services/admin/inbound-repository.drizzle.js"
import { makeDrizzleMailRepository } from "../../src/services/admin/mail-repository.drizzle.js"
import {
  makeDrizzleInboxFeedRepository,
  type InboxFeedRepository,
} from "../../src/services/admin/inbox-feed-repository.drizzle.js"

const pg = await withPg()

const at = (minute: number): Date => new Date(Date.UTC(2026, 5, 1, 0, minute, 0))

describe.skipIf(!pg)("inbox feed repository (integration: real schema)", () => {
  let h: PgHarness
  let feed: InboxFeedRepository

  beforeAll(() => {
    h = pg as PgHarness
    feed = makeDrizzleInboxFeedRepository(h.sql)
  })

  beforeEach(async () => {
    await h.sql`TRUNCATE mail_events, mail_messages, mail_threads, inbound_emails RESTART IDENTITY CASCADE`
  })

  afterAll(async () => {
    await h.teardown()
  })

  async function email(minute: number, recipient: string, verdict?: string): Promise<string> {
    const { id } = await makeDrizzleInboundRepository(h.sql).insertIdempotent({
      messageId: `<feed-${minute}-${recipient}>`,
      fromAddr: "resident@example.com",
      toAddr: recipient,
      recipient,
      subject: `Email ${minute}`,
      bodyText: null,
      bodyHtml: "<p>Html only</p>",
      headers: verdict === undefined ? {} : { "x-civfix-auth-verdict": verdict },
      attachments: [],
      receivedAt: at(minute),
    })
    return id
  }

  async function reply(
    threadId: string,
    minute: number,
    over: { unaffiliated?: boolean; verdict?: "pass" | "fail"; applied?: boolean } = {},
  ): Promise<string> {
    const message = await makeDrizzleMailRepository(h.sql).insertMessage({
      threadId,
      direction: "in",
      fromAddr: "clerk@lacity.gov",
      body: `Reply ${minute}`,
      attachments: [{ key: "k", filename: "a.pdf", size: 1 }],
      messageId: `<reply-${minute}-${threadId}>`,
      unaffiliated: over.unaffiliated ?? false,
      authVerdict: over.verdict ?? "pass",
    })
    await h.sql`
      UPDATE mail_messages
      SET created_at = ${at(minute)},
          effects_applied_at = CASE WHEN ${over.applied === true} THEN now() ELSE NULL END
      WHERE id = ${message!.id}
    `
    return message!.id
  }

  async function mailbox(): Promise<Record<string, string>> {
    const [report] = await h.sql<{ id: string }[]>`
      INSERT INTO reports (idempotency_key, geom, geom_source, category, status, h3_cell, jurisdiction_geoid)
      VALUES (gen_random_uuid(), ST_SetSRID(ST_MakePoint(-118.25, 34.05), 4326), 'gps', 'graffiti',
              'published', '8a2a1072b59ffff', ${LA_CITY.geoid})
      RETURNING id
    `
    const mail = makeDrizzleMailRepository(h.sql)
    const linked = await mail.findOrCreateReportThread(report!.id, {
      org: "Streets Dept",
      subject: "Graffiti",
      status: "needs_action",
    })
    const loose = await mail.createThread({ org: "Lighting", subject: "Streetlight" })
    const e2 = await email(3, "reports@civfix.org")
    await makeDrizzleInboundRepository(h.sql).setStatus(e2, "archived", null)
    return {
      reportId: report!.id,
      linked: linked.id,
      e1: await email(1, "support@civfix.org", "fail"),
      e2,
      withheld: await reply(linked.id, 2, { unaffiliated: true, verdict: "fail" }),
      loose: await reply(loose.id, 4, { unaffiliated: true }),
      published: await reply(linked.id, 5, { applied: true }),
    }
  }

  async function ids(query: InboxFeedQuery): Promise<string[]> {
    return (await feed.list(query)).items.map((item) => item.id)
  }

  it("merges both tables newest-first and maps every column of each source", async () => {
    const s = await mailbox()
    const page = InboxFeedResponseSchema.parse(await feed.list({}))

    expect(page.items.map((i) => i.id)).toEqual([s.published, s.loose, s.e2, s.withheld, s.e1])
    expect(page.nextCursor).toBeNull()
    expect(page.items.find((i) => i.id === s.withheld)).toMatchObject({
      threadId: s.linked,
      reportId: s.reportId,
      subject: "Graffiti",
      ts: at(2).toISOString(),
      threadStatus: "needs_action",
      hasAttachments: true,
      authVerdict: "fail",
      publication: "withheld",
    })
    expect(page.items.find((i) => i.id === s.e1)).toMatchObject({
      source: "email",
      recipient: "support@civfix.org",
      preview: "Html only",
      status: "unread",
      authVerdict: "fail",
    })
    expect(page.items.find((i) => i.id === s.loose)).toMatchObject({ publication: null })
    expect(page.items.find((i) => i.id === s.published)).toMatchObject({ publication: "published" })
  })

  it("filters each source exactly as the contract's table says", async () => {
    const s = await mailbox()
    expect(await ids({ filter: "unread" })).toEqual([s.published, s.loose, s.withheld, s.e1])
    expect(await ids({ filter: "replies" })).toEqual([s.published, s.loose, s.withheld])
    expect(await ids({ filter: "review" })).toEqual([s.withheld])
    expect(await ids({ filter: "unmatched" })).toEqual([s.e2, s.e1])
    expect(await ids({ filter: "archived" })).toEqual([s.e2])
    expect(await ids({ q: "support" })).toEqual([s.e1])
  })

  it("walks one keyset across both tables, breaking a timestamp tie by id", async () => {
    await mailbox()
    await email(5, "support@civfix.org")
    const all = await ids({})
    const walked: string[] = []
    let cursor: string | null = null
    do {
      const page = await feed.list({ limit: 1, ...(cursor === null ? {} : { cursor }) })
      walked.push(...page.items.map((i) => i.id))
      cursor = page.nextCursor
    } while (cursor !== null)
    expect(walked).toEqual(all)
    expect(all).toHaveLength(6)
    expect(all.slice(0, 2).sort().reverse()).toEqual(all.slice(0, 2))
  })

  it("walks rows that share a millisecond by their microseconds, skipping none", async () => {
    const s = await mailbox()
    const microsecond = (micros: string) => `2027-01-01T00:00:00.${micros}Z`
    await h.sql`UPDATE inbound_emails SET received_at = ${microsecond("123100")}::text::timestamptz`
    await h.sql`
      UPDATE mail_messages SET created_at = ${microsecond("123500")}::text::timestamptz
      WHERE id IN (${s.withheld!}, ${s.published!})
    `
    const all = await ids({})
    const walked: string[] = []
    let cursor: string | null = null
    do {
      const page = await feed.list({ limit: 1, ...(cursor === null ? {} : { cursor }) })
      walked.push(...page.items.map((i) => i.id))
      cursor = page.nextCursor
    } while (cursor !== null)
    expect(walked).toEqual(all)
    expect(all).toHaveLength(5)
  })
})
