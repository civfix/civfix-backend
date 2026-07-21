import type { Queryable, Sql } from "../db/client.js"
import type { UserMentionDTO } from "@civfix/shared"

// The USER @-mention tables across the messaging stacks share an identical layout
// (<idColumn>, mentioned_user_id) with PK(<idColumn>, mentioned_user_id); chat + DM share one physical
// table. Only the table name (and, for posts, the id-column name) differs, so one parameterized repo
// serves all of them. `table`/`idColumn` are module-constant union literals (never user input),
// interpolated as postgres.js identifiers (`sql(table)` / `sql(idColumn)`).
export type MentionTable =
  | "chat_message_mentions"
  | "report_message_user_mentions"
  | "post_mentions"

// The owning-row FK column: 'message_id' for the chat/report tables, 'post_id' for post_mentions (0051).
export type MentionIdColumn = "message_id" | "post_id"

export interface MessageMentionRepo {
  // Replace the message's mention set (delete-then-insert). `mentionedUserIds` must already be deduped +
  // self-excluded by the caller. Pass the create/edit tx so the replace is atomic with the message write.
  recordFor(tx: Queryable, messageId: string, mentionedUserIds: string[]): Promise<void>
  // Batched: one grouped join for the whole id set, never one query per message (the N+1 fix).
  loadFor(messageIds: string[]): Promise<Map<string, UserMentionDTO[]>>
}

export function makeMentionRepo(
  sql: Sql,
  table: MentionTable,
  idColumn: MentionIdColumn = "message_id",
): MessageMentionRepo {
  return {
    async recordFor(tx, messageId, mentionedUserIds) {
      await tx`DELETE FROM ${tx(table)} WHERE ${tx(idColumn)} = ${messageId}`
      if (mentionedUserIds.length === 0) return
      const values: Record<string, string>[] = mentionedUserIds.map((uid) => ({
        [idColumn]: messageId,
        mentioned_user_id: uid,
      }))
      await tx`
        INSERT INTO ${tx(table)} ${tx(values, idColumn, "mentioned_user_id")}
        ON CONFLICT (${tx(idColumn)}, mentioned_user_id) DO NOTHING
      `
    },

    loadFor(messageIds) {
      return loadMentionsFor(sql, table, messageIds, idColumn)
    },
  }
}

// Standalone batched loader so a repo can pass its own transaction/tag. UserMentionDTO.handle is
// non-null; a mentioned user always has a handle in practice (mentions resolve from @handles), but
// coalesce defensively so a NULL-handle row never breaks the contract.
export async function loadMentionsFor(
  tag: Queryable,
  table: MentionTable,
  messageIds: string[],
  idColumn: MentionIdColumn = "message_id",
): Promise<Map<string, UserMentionDTO[]>> {
  const byMessage = new Map<string, UserMentionDTO[]>()
  if (messageIds.length === 0) return byMessage
  const rows = await tag<{ mkey: string; id: string; handle: string | null; display_name: string }[]>`
    SELECT m.${tag(idColumn)} AS mkey, u.id, u.handle, u.display_name
    FROM ${tag(table)} m
    JOIN users u ON u.id = m.mentioned_user_id
    WHERE m.${tag(idColumn)} IN ${tag(messageIds)}
    ORDER BY m.${tag(idColumn)} ASC, u.handle ASC, u.id ASC
  `
  for (const r of rows) {
    const dto: UserMentionDTO = { id: r.id, handle: r.handle ?? "", displayName: r.display_name }
    const list = byMessage.get(r.mkey)
    if (list) list.push(dto)
    else byMessage.set(r.mkey, [dto])
  }
  return byMessage
}
