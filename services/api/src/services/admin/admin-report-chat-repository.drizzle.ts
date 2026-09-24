import type { RoomKind } from "@civfix/shared"
import type { Queryable, Sql } from "../../db/client.js"
import { insertAuditRow } from "./audit-repository.drizzle.js"
import type {
  AdminReportChatRepository,
  RemoveReportMessageInput,
} from "./admin-report-chat-repository.js"

export async function findMessageRoom(
  sql: Queryable,
  messageId: string,
): Promise<{ kind: RoomKind; id: string } | null> {
  const rows = await sql<{ room_kind: RoomKind; room_id: string }[]>`
    SELECT 'dm'::text AS room_kind, thread_id::text AS room_id
      FROM dm_messages WHERE id = ${messageId}
    UNION ALL
    SELECT CASE
             WHEN report_id IS NOT NULL THEN 'report'
             WHEN group_id IS NOT NULL THEN 'group'
             ELSE 'cleanup'
           END AS room_kind,
           COALESCE(report_id, group_id, cleanup_id)::text AS room_id
      FROM chat_messages WHERE id = ${messageId}
    LIMIT 1
  `
  const row = rows[0]
  return row === undefined ? null : { kind: row.room_kind, id: row.room_id }
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
        await insertAuditRow(tx, {
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
