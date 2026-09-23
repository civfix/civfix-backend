import type { Queryable, Sql } from "../db/client.js"
import type { ReactionEmoji, ReactionSummaryDTO } from "@civfix/shared"

// The reaction tables share an identical layout (message_id, user_id, emoji, created_at) and a
// PK(message_id, user_id, emoji), so one parameterized repo serves them. `table` is a module-constant union
// literal (never user input), interpolated as a postgres.js identifier (`sql(table)`). Today cleanup chat,
// report chat, group chat and DMs all ride the ONE chat table (message ids are globally-unique uuids), so
// the union has a single member; the removed "report_message_reactions" belonged to the deleted per-report
// discussion stack and had no caller left.
export type ReactionTable = "chat_message_reactions"

export interface MessageReactionRepo {
  // True when the reaction is now PRESENT (added), false when it was removed.
  toggle(messageId: string, userId: string, emoji: ReactionEmoji): Promise<boolean>
  // Batched: one grouped query for the whole id set, never one query per message (the N+1 fix).
  loadFor(
    messageIds: string[],
    viewerUserId: string | null,
  ): Promise<Map<string, ReactionSummaryDTO[]>>
}

export function makeReactionRepo(sql: Sql, table: ReactionTable): MessageReactionRepo {
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

// Standalone batched loader so a repo can pass its own transaction/tag (history reads run inside the
// same connection as the page select). `mine` is false for an anonymous viewer.
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
