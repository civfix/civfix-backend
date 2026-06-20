/**
 * Shared persistence helpers for CHAT message reactions (the chat_message_reactions table, which serves
 * BOTH the cleanup group chat and 1:1 DMs — message ids are globally-unique uuids across both). Factored
 * out of chat-repository.drizzle.ts / dm-repository.drizzle.ts so the two repos aggregate + toggle the
 * SAME table identically. Mirrors discussion-repository.drizzle.ts loadReactions + toggleReaction exactly.
 */

import type { Queryable, Sql } from "../db/client.js"
import type { ReactionEmoji, ReactionSummaryDTO } from "@civfix/shared"

/**
 * Aggregate per-emoji reaction counts for ONE chat/dm message into the wire ReactionSummaryDTO[], with a
 * `mine` flag resolved for the viewer (false when the viewer is anonymous). Ordered by emoji for a stable
 * render. Mirrors the discussion repo's loadReactions.
 */
export async function loadChatReactions(
  tag: Queryable,
  messageId: string,
  viewerUserId: string | null,
): Promise<ReactionSummaryDTO[]> {
  const rows = await tag<{ emoji: string; count: number; mine: boolean }[]>`
    SELECT
      emoji,
      count(*)::int AS count,
      bool_or(user_id = ${viewerUserId}) AS mine
    FROM chat_message_reactions
    WHERE message_id = ${messageId}
    GROUP BY emoji
    ORDER BY emoji ASC
  `
  return rows.map((r) => ({
    emoji: r.emoji as ReactionEmoji,
    count: r.count,
    mine: viewerUserId !== null && r.mine,
  }))
}

/**
 * Toggle a reaction on a chat/dm message: try to DELETE an existing (message,user,emoji); if nothing was
 * deleted, INSERT it. Done in one transaction so a concurrent double-toggle cannot land both a delete and
 * an insert out of order. Returns true when the reaction is now PRESENT (added), false when removed.
 * Mirrors the discussion repo's toggleReaction.
 */
export function toggleChatReaction(
  sql: Sql,
  messageId: string,
  userId: string,
  emoji: ReactionEmoji,
): Promise<boolean> {
  return sql.begin(async (tx) => {
    const deleted = await tx<{ message_id: string }[]>`
      DELETE FROM chat_message_reactions
      WHERE message_id = ${messageId} AND user_id = ${userId} AND emoji = ${emoji}
      RETURNING message_id
    `
    if (deleted.length > 0) return false
    await tx`
      INSERT INTO chat_message_reactions (message_id, user_id, emoji)
      VALUES (${messageId}, ${userId}, ${emoji})
      ON CONFLICT (message_id, user_id, emoji) DO NOTHING
    `
    return true
  })
}
