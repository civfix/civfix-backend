// chat_message_reactions serves both room chat and 1:1 DMs because message ids are globally unique
// uuids across both tables.

import type { Queryable, Sql } from "../db/client.js"
import type { ReactionEmoji, ReactionSummaryDTO } from "@civfix/shared"
import {
  loadReactionsFor,
  makeMessageReactionRepository,
} from "./message-reactions-repository.drizzle.js"

const CHAT_REACTIONS = "chat_message_reactions" as const

export async function loadChatReactions(
  tag: Queryable,
  messageId: string,
  viewerUserId: string | null,
): Promise<ReactionSummaryDTO[]> {
  return (
    (await loadReactionsFor(tag, CHAT_REACTIONS, [messageId], viewerUserId)).get(messageId) ?? []
  )
}

export function loadChatReactionsFor(
  tag: Queryable,
  messageIds: string[],
  viewerUserId: string | null,
): Promise<Map<string, ReactionSummaryDTO[]>> {
  return loadReactionsFor(tag, CHAT_REACTIONS, messageIds, viewerUserId)
}

/** true when the reaction is now present, false when it was removed. */
export function toggleChatReaction(
  sql: Sql,
  messageId: string,
  userId: string,
  emoji: ReactionEmoji,
): Promise<boolean> {
  return makeMessageReactionRepository(sql, CHAT_REACTIONS).toggle(messageId, userId, emoji)
}
