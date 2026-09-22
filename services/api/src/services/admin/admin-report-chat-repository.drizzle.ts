import type { Sql } from "../../db/client.js"
import { writeAudit } from "./audit.js"

export interface RemoveReportMessageInput {
  reason: string | null
  actorId: string | null
}

export interface AdminReportChatRepository {
  reportExists(reportId: string): Promise<boolean>
  removeMessage(
    reportId: string,
    messageId: string,
    input: RemoveReportMessageInput,
  ): Promise<boolean>
}

export function makeDrizzleAdminReportChatRepository(sql: Sql): AdminReportChatRepository {
  return {
    async reportExists(reportId: string): Promise<boolean> {
      const rows = await sql<{ id: string }[]>`
        SELECT id FROM reports WHERE id = ${reportId} LIMIT 1
      `
      return rows.length > 0
    },

    async removeMessage(
      reportId: string,
      messageId: string,
      input: RemoveReportMessageInput,
    ): Promise<boolean> {
      return sql.begin(async (tx) => {
        const removed = await tx<{ id: string }[]>`
          UPDATE chat_messages
          SET deleted_at = now()
          WHERE id = ${messageId} AND report_id = ${reportId}
            AND deleted_at IS NULL AND sender_id IS NOT NULL
          RETURNING id
        `
        if (removed.length === 0) return false
        await writeAudit(tx, {
          actorId: input.actorId,
          action: "report_message.removed",
          target: `message:${messageId}`,
          meta: { reportId, reason: input.reason },
        })
        return true
      })
    },
  }
}
