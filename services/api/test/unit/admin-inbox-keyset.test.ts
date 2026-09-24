import { describe, expect, it } from "vitest"
import type { Sql } from "../../src/db/client.js"
import { makeFakeSql } from "../helpers/fake-sql.js"
import { makeDrizzleInboundRepository } from "../../src/services/admin/inbound-repository.drizzle.js"
import { makeDrizzleInboxFeedRepository } from "../../src/services/admin/inbox-feed-repository.drizzle.js"

const A = "aaaaaaaa-0000-4000-8000-000000000001"
const B = "aaaaaaaa-0000-4000-8000-000000000002"
const TS = new Date("2027-01-01T00:00:00.123Z")
const INSTANT = "2027-01-01T00:00:00.123456Z"

const emailRow = (id: string) => ({
  source: "email",
  id,
  ts: TS,
  received_at: TS,
  cursor_at: INSTANT,
  from_addr: "resident@example.com",
  recipient: "support@civfix.org",
  subject: "Probe",
  preview_text: "Hello",
  preview_html: null,
  has_attachments: false,
  status: "unread",
  auth_verdict: null,
})

const repos = {
  "the inbox feed": (sql: Sql) => makeDrizzleInboxFeedRepository(sql),
  "the unmatched inbox": (sql: Sql) => makeDrizzleInboundRepository(sql),
}

describe.each(Object.entries(repos))("%s keyset", (_name, make) => {
  it("pages from the row's microsecond instant, not its millisecond Date", async () => {
    const db = makeFakeSql([{ match: /inbound_emails/, rows: [emailRow(A), emailRow(B)] }])
    const repo = make(db.sql as unknown as Sql)

    const first = await repo.list({ limit: 1 })
    expect(first.nextCursor).toBe(`${INSTANT}|${A}`)

    await repo.list({ limit: 1, cursor: first.nextCursor! })
    const next = db.statements.at(-1)!
    expect(next.values).toContain(INSTANT)
    expect(next.values).not.toContainEqual(TS)
    expect(next.sql).toMatch(/\) < \(\?::timestamptz, \?::uuid\)/)
  })
})
