import type { Queryable, Sql } from "../db/client.js"
import type { ReactionEmoji, ReactionSummaryDTO } from "@civfix/shared"
import type { MessageReactionRepository } from "./message-reactions-repository.js"

// `table` is a module-constant union literal, never user input, interpolated as a postgres.js identifier.
// Every room kind and DMs share the one chat table because message ids are globally unique uuids.
export type ReactionTable = "chat_message_reactions"

export function makeMessageReactionRepository(
  sql: Sql,
  table: ReactionTable,
): MessageReactionRepository {
  return {
    toggle(messageId, userId, emoji) {
      // One tx so a concurrent double-toggle can't interleave a delete and an insert out of order.
      return sql.begin(async (tx) => {
        const deleted = await tx<{ message_id: string }[]>`
          DELETE FROM ${tx(table)}
          WHERE message_id = ${messageId} AND user_id = ${userId} AND emoji = ${emoji}
          RETURNING message_id
        `
        if (deleted.length > 0) return false
        await tx`
          INSERT INTO ${tx(table)} (message_id, user_id, emoji)
          VALUES (${messageId}, ${userId}, ${emoji})
          ON CONFLICT (message_id, user_id, emoji) DO NOTHING
        `
        return true
      })
    },

    loadFor(messageIds, viewerUserId) {
      return loadReactionsFor(sql, table, messageIds, viewerUserId)
    },
  }
}

// Standalone so a repo can pass its own transaction: history reads run on the same connection as the
// page select.
export async function loadReactionsFor(
  tag: Queryable,
  table: ReactionTable,
  messageIds: string[],
  viewerUserId: string | null,
): Promise<Map<string, ReactionSummaryDTO[]>> {
  const byMessage = new Map<string, ReactionSummaryDTO[]>()
  if (messageIds.length === 0) return byMessage
  const rows = await tag<{ message_id: string; emoji: string; count: number; mine: boolean }[]>`
    SELECT
      message_id,
      emoji,
      count(*)::int AS count,
      bool_or(user_id = ${viewerUserId}) AS mine
    FROM ${tag(table)}
    WHERE message_id IN ${tag(messageIds)}
    GROUP BY message_id, emoji
    ORDER BY message_id ASC, emoji ASC
  `
  for (const r of rows) {
    const dto: ReactionSummaryDTO = {
      emoji: r.emoji as ReactionEmoji,
      count: r.count,
      mine: viewerUserId !== null && r.mine,
    }
    const list = byMessage.get(r.message_id)
    if (list) list.push(dto)
    else byMessage.set(r.message_id, [dto])
  }
  return byMessage
}
