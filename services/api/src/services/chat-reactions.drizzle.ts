/**
 * Chat/DM message reactions: thin binders over the table-parameterized message-reactions repo
 * (message-reactions.drizzle.ts). chat_message_reactions serves BOTH the cleanup group chat and 1:1 DMs
 * (message ids are globally-unique uuids across both), so the chat + dm repos toggle/aggregate it
 * identically — the shared module is the single algorithm; these are the chat-table bindings.
 */

import type { Queryable, Sql } from "../db/client.js"
import type { ReactionEmoji, ReactionSummaryDTO } from "@civfix/shared"
import { loadReactionsFor, makeReactionRepo } from "./message-reactions.drizzle.js"

const CHAT_REACTIONS = "chat_message_reactions" as const

/** Aggregate ONE chat/dm message's reactions for the viewer. */
export async function loadChatReactions(
  tag: Queryable,
  messageId: string,
  viewerUserId: string | null,
): Promise<ReactionSummaryDTO[]> {
  return (await loadReactionsFor(tag, CHAT_REACTIONS, [messageId], viewerUserId)).get(messageId) ?? []
}

/** Batched: one grouped query for a whole page of message ids (the N+1 fix for list reads). */
export function loadChatReactionsFor(
  tag: Queryable,
  messageIds: string[],
  viewerUserId: string | null,
): Promise<Map<string, ReactionSummaryDTO[]>> {
  return loadReactionsFor(tag, CHAT_REACTIONS, messageIds, viewerUserId)
}

/** Toggle a reaction in one tx; true when now present (added), false when removed. */
export function toggleChatReaction(
  sql: Sql,
  messageId: string,
  userId: string,
  emoji: ReactionEmoji,
): Promise<boolean> {
  return makeReactionRepo(sql, CHAT_REACTIONS).toggle(messageId, userId, emoji)
}
