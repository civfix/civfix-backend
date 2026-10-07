import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { withPg, testHandle, type PgHarness } from "../helpers/pg.js"
import { CIVFIX_OFFICIAL_USER_ID } from "../../src/auth/official-account.js"
import { makeDrizzleChatRepository } from "../../src/services/chat-repository.drizzle.js"
import { makeAuditedReportChatPersist } from "../../src/services/report-chat-send-wiring.js"
import type { ReportChatSendDeps } from "../../src/services/report-chat-send.js"

const pg = await withPg()

describe.skipIf(!pg)("admin report chat posts as the official account (integration)", () => {
  let h: PgHarness
  let persist: ReportChatSendDeps["persist"]
  let operatorId: string
  let reportId: string

  beforeAll(async () => {
    h = pg as PgHarness
    const chatRepo = makeDrizzleChatRepository(h.sql)
    persist = makeAuditedReportChatPersist(() => chatRepo)
    const [operator] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name, handle, role) VALUES ('Op', ${testHandle()}, 'operator') RETURNING id
    `
    operatorId = operator!.id
    const [report] = await h.sql<{ id: string }[]>`
      INSERT INTO reports (idempotency_key, geom, geom_source, category, status, visibility, h3_cell)
      VALUES (
        ${randomUUID()}, ST_SetSRID(ST_MakePoint(-118.35, 34.1), 4326),
        'manual', 'trash', 'published', 'public', 'h0'
      )
      RETURNING id
    `
    reportId = report!.id
  })

  afterAll(async () => {
    await h.teardown()
  })

  function post(body: string, actingUserId: string) {
    return persist(
      { cleanupId: reportId, roomKind: "report", userId: CIVFIX_OFFICIAL_USER_ID, body },
      { actingUserId },
    )
  }

  it("writes the chat row under the official account and audits the operator in the same commit", async () => {
    const message = await post("Crew dispatched.", operatorId)

    expect(message.from).toMatchObject({
      id: CIVFIX_OFFICIAL_USER_ID,
      name: "CivFix",
      handle: "civfix",
    })
    const [row] = await h.sql<{ sender_id: string }[]>`
      SELECT sender_id FROM chat_messages WHERE id = ${message.id}
    `
    expect(row?.sender_id).toBe(CIVFIX_OFFICIAL_USER_ID)
    const audits = await h.sql<{ actor_id: string; target: string; meta: { messageId: string } }[]>`
      SELECT actor_id, target, meta FROM audit_log WHERE action = 'report.message_posted'
    `
    expect(audits).toEqual([
      { actor_id: operatorId, target: `report:${reportId}`, meta: { messageId: message.id } },
    ])
  })

  it("rolls the chat row back when its audit row cannot be written", async () => {
    await expect(post("Never lands.", randomUUID())).rejects.toThrow()

    const rows = await h.sql`
      SELECT 1 FROM chat_messages WHERE report_id = ${reportId} AND body = 'Never lands.'
    `
    expect(rows).toHaveLength(0)
  })
})
