/**
 * Chat/DM message USER @-mentions: thin binders over the table-parameterized message-mentions repo
 * (message-mentions.drizzle.ts). chat_message_mentions serves BOTH the cleanup group chat and 1:1 DMs
 * (message ids are globally-unique uuids across both). The WRITE path is driven from the WS gateway seam
 * AFTER persist (a mention failure never blocks the message); these are the chat-table bindings.
 */

import type { Queryable, Sql } from "../db/client.js"
import type { UserMentionDTO } from "@civfix/shared"
import { loadMentionsFor, makeMentionRepo } from "./message-mentions.drizzle.js"

const CHAT_MENTIONS = "chat_message_mentions" as const

/** Load the resolved @-mentions on ONE chat/dm message. */
export async function loadChatMentions(
  tag: Queryable,
  messageId: string,
): Promise<UserMentionDTO[]> {
  return (await loadMentionsFor(tag, CHAT_MENTIONS, [messageId])).get(messageId) ?? []
}

/** Batched: one grouped join for a whole page of message ids (the N+1 fix for list reads). */
export function loadChatMentionsFor(
  tag: Queryable,
  messageIds: string[],
): Promise<Map<string, UserMentionDTO[]>> {
  return loadMentionsFor(tag, CHAT_MENTIONS, messageIds)
}

/**
 * Replace a chat/dm message's mention set (caller dedupes + self-excludes the ids). The replace is
 * delete-then-insert, so it runs in ONE transaction as recordFor documents: handed the bare pool tag it
 * was two independent statements, and a crash or a concurrent edit landing between them could leave the
 * message with no mentions at all (or a merged set from both writers).
 */
export async function recordChatMentions(
  sql: Sql,
  messageId: string,
  mentionedUserIds: string[],
): Promise<void> {
  const repo = makeMentionRepo(sql, CHAT_MENTIONS)
  await sql.begin(async (tx) => {
    await repo.recordFor(tx, messageId, mentionedUserIds)
  })
}

export type MentionScopeKind = "cleanup" | "report" | "group"

const MEMBER_TABLES: Record<
  MentionScopeKind,
  {
    table: "cleanup_members" | "report_chat_members" | "chat_group_members"
    scope: "cleanup_id" | "report_id" | "group_id"
  }
> = {
  cleanup: { table: "cleanup_members", scope: "cleanup_id" },
  report: { table: "report_chat_members", scope: "report_id" },
  group: { table: "chat_group_members", scope: "group_id" },
}

/**
 * Which of `candidateIds` are current members of the room. A primary-key probe per candidate, bounded by
 * the mentions a message can carry, so a member who joined after any roster cap is still mentionable.
 */
export async function roomMemberIdsAmong(
  sql: Queryable,
  kind: MentionScopeKind,
  roomId: string,
  candidateIds: string[],
): Promise<string[]> {
  if (candidateIds.length === 0) return []
  const { table, scope } = MEMBER_TABLES[kind]
  const rows = await sql<{ user_id: string }[]>`
    SELECT user_id FROM ${sql(table)}
    WHERE ${sql(scope)} = ${roomId} AND user_id = ANY(${candidateIds}::uuid[])
  `
  return rows.map((r) => r.user_id)
}
