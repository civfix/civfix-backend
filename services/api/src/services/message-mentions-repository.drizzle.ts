import type { Queryable, Sql } from "../db/client.js"
import type { UserMentionDTO } from "@civfix/shared"
import type { MessageMentionRepository } from "./message-mentions-repository.js"

// `table` and `idColumn` are module-constant union literals, never user input, interpolated as postgres.js
// identifiers.
export type MentionTable = "chat_message_mentions" | "post_mentions"

export type MentionIdColumn = "message_id" | "post_id"

export function makeMessageMentionRepository(
  sql: Sql,
  table: MentionTable,
  idColumn: MentionIdColumn = "message_id",
): MessageMentionRepository {
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

// Standalone so a repo can pass its own transaction. UserMentionDTO.handle is non-null and mentions
// resolve from @handles, but the coalesce keeps a NULL-handle row from breaking the contract.
export async function loadMentionsFor(
  tag: Queryable,
  table: MentionTable,
  messageIds: string[],
  idColumn: MentionIdColumn = "message_id",
): Promise<Map<string, UserMentionDTO[]>> {
  const byMessage = new Map<string, UserMentionDTO[]>()
  if (messageIds.length === 0) return byMessage
  const rows = await tag<
    { mkey: string; id: string; handle: string | null; display_name: string }[]
  >`
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
