/**
 * chat_message_mentions serves both room chat and 1:1 DMs because message ids are globally unique uuids
 * across both tables. Writes run after the message persists, so a mention failure never blocks it.
 */

import type { Queryable, Sql } from "../db/client.js"
import type { UserMentionDTO } from "@civfix/shared"
import { loadMentionsFor, makeMentionRepo } from "./message-mentions-repository.drizzle.js"

const CHAT_MENTIONS = "chat_message_mentions" as const

export async function loadChatMentions(
  tag: Queryable,
  messageId: string,
): Promise<UserMentionDTO[]> {
  return (await loadMentionsFor(tag, CHAT_MENTIONS, [messageId])).get(messageId) ?? []
}

export function loadChatMentionsFor(
  tag: Queryable,
  messageIds: string[],
): Promise<Map<string, UserMentionDTO[]>> {
  return loadMentionsFor(tag, CHAT_MENTIONS, messageIds)
}

/**
 * The caller dedupes and self-excludes the ids. The replace is delete-then-insert, so it must run in one
 * transaction: on the bare pool tag a crash or a concurrent edit between the two statements could leave
 * the message with no mentions, or a merged set from both writers.
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
 * A primary-key probe per candidate, bounded by the mentions a message can carry, so a member who joined
 * after any roster cap is still mentionable.
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
