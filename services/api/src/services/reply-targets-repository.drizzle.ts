import type { ChatMessageKind } from "@civfix/shared"
import type { Queryable } from "../db/client.js"

/** Trusted internal identifiers, rendered via sql(...) as idents. */
export type ReplyTable = "chat_messages" | "dm_messages"

/** Column names are trusted internal identifiers. */
export interface ReplyRoomScope {
  column: "cleanup_id" | "report_id" | "group_id" | "thread_id"
  id: string
}

export interface ReplyTargetRow {
  id: string
  room_ref?: string | null
  body: string | null
  kind: ChatMessageKind
  deleted_at: Date | null
  sender_id: string | null
  sender_display_name: string | null
  sender_deleted_at: Date | null
}

export async function findReplyTarget(
  sql: Queryable,
  table: ReplyTable,
  scope: ReplyRoomScope,
  replyToId: string,
): Promise<ReplyTargetRow | null> {
  const rows = await sql<ReplyTargetRow[]>`
    SELECT
      m.id,
      m.${sql(scope.column)} AS room_ref,
      m.body,
      m.kind,
      m.deleted_at,
      m.sender_id,
      u.display_name AS sender_display_name,
      u.deleted_at AS sender_deleted_at
    FROM ${sql(table)} m
    LEFT JOIN users u ON u.id = m.sender_id
    WHERE m.id = ${replyToId}
    LIMIT 1
  `
  return rows[0] ?? null
}

export async function loadReplyTargetRows(
  sql: Queryable,
  table: ReplyTable,
  distinct: string[],
): Promise<ReplyTargetRow[]> {
  const rows = await sql<ReplyTargetRow[]>`
    SELECT
      m.id,
      m.body,
      m.kind,
      m.deleted_at,
      m.sender_id,
      u.display_name AS sender_display_name,
      u.deleted_at AS sender_deleted_at
    FROM ${sql(table)} m
    LEFT JOIN users u ON u.id = m.sender_id
    WHERE m.id = ANY(${distinct}::uuid[])
  `
  return rows
}
