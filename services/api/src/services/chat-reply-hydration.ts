/**
 * Reply threading (P2 Task 2.3): validation + hydration for chat/dm reply targets.
 *
 * chat_messages and dm_messages both carry a nullable reply_to_id (migration 0045) referencing another
 * row IN THE SAME TABLE. This module is the single home for:
 *
 *   - assertReplyTarget: persist-time validation that the target exists in the SAME room (cleanup_id /
 *     report_id equality for chat, thread_id equality for dm) and is not tombstoned. Violations throw a
 *     422 AppError whose machine subcode rides `fields.code` ("reply_wrong_room" /
 *     "reply_deleted_target"), following the chat-edit-service convention (ErrorCode is a closed enum,
 *     so clients key off httpStatus + fields.code). On success it returns the hydrated ReplyToDTO so
 *     the ack/broadcast DTO carries the preview without a second fetch.
 *   - loadReplyTargets / replyMapForRows: batched hydration for history pages and re-read single rows —
 *     ONE `id = ANY(...)` query per page over the SAME table, keyed by target id.
 *
 * DTO MAPPING (toReplyToDTO):
 *   - excerpt = the first REPLY_EXCERPT_MAX (120) chars of the target's body when a body is present;
 *     otherwise "" — the DTO carries raw data and the CLIENT renders a kind-based descriptor (e.g.
 *     "Photo" for an attachment-only message) from `kind`, so localization stays client-side.
 *   - from = {id, displayName} of the target's sender; null for sender-less SYSTEM rows and for
 *     tombstoned (deleted) sender accounts.
 *   - deleted: true + excerpt "" when the target itself is tombstoned — the original text must not
 *     survive its deletion via the reply preview.
 *
 * Kept as a pure-ish standalone service (no repo coupling) so later tasks (2.4 around-mode, 2.5
 * notifications) can consume the same loaders.
 */

import { AppError, ErrorCode } from "@civfix/shared"
import type { ChatMessageKind, ReplyToDTO } from "@civfix/shared"
import type { Queryable } from "../db/client.js"
import { isUuid } from "../db/cursor-helpers.js"

/** The two reply-capable tables. Trusted internal identifiers (rendered via sql(...) as idents). */
export type ReplyTable = "chat_messages" | "dm_messages"

/**
 * The room-equality column for reply validation: chat rooms scope on cleanup_id/report_id/group_id,
 * dm threads on thread_id. Column names are trusted internal identifiers.
 */
export interface ReplyRoomScope {
  column: "cleanup_id" | "report_id" | "group_id" | "thread_id"
  id: string
}

export const REPLY_EXCERPT_MAX = 120

/** The target-row shape both loaders select (room_ref only on the validation path). */
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

export const replyWrongRoom = (): AppError =>
  new AppError(ErrorCode.VALIDATION, "The message you're replying to isn't in this conversation.", {
    fields: { code: "reply_wrong_room" },
  })

export const replyDeletedTarget = (): AppError =>
  new AppError(ErrorCode.VALIDATION, "The message you're replying to was deleted.", {
    fields: { code: "reply_deleted_target" },
  })

/** The poll reply-excerpt prefix (P6): a bar-chart glyph so a quoted poll reads as "📊 <question>". */
const POLL_EXCERPT_PREFIX = "\u{1F4CA} "

/** Pure mapper: one target row -> the denormalized reply preview (see DTO MAPPING above). */
export function toReplyToDTO(row: ReplyTargetRow): ReplyToDTO {
  const deleted = row.deleted_at !== null
  const from =
    row.sender_id !== null && row.sender_deleted_at === null
      ? { id: row.sender_id, displayName: row.sender_display_name ?? "" }
      : null
  // A poll's body IS its question; prefix the chart glyph so the quote reads as a poll, truncated at the
  // shared cap. Every other kind excerpts its raw body (client renders a kind descriptor for empty ones).
  const excerpt = deleted
    ? ""
    : row.kind === "poll"
      ? (POLL_EXCERPT_PREFIX + (row.body ?? "")).slice(0, REPLY_EXCERPT_MAX)
      : (row.body ?? "").slice(0, REPLY_EXCERPT_MAX)
  return {
    id: row.id,
    from,
    excerpt,
    kind: row.kind,
    ...(deleted ? { deleted: true } : {}),
  }
}

/**
 * Validate a reply target at persist/send time (same room + not deleted) and return its hydrated
 * preview. ONE query: the target row + its sender, with the scope column projected as room_ref.
 * A missing row and a wrong-room row are indistinguishable to the sender (both "not in this
 * conversation"), so both throw reply_wrong_room; a non-uuid id can never match and short-circuits
 * the same way (avoiding a 22P02 cast error -> 500).
 */
export async function assertReplyTarget(
  sql: Queryable,
  table: ReplyTable,
  scope: ReplyRoomScope,
  replyToId: string,
): Promise<ReplyToDTO> {
  if (!isUuid(replyToId)) throw replyWrongRoom()
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
  const row = rows[0]
  if (!row || row.room_ref !== scope.id) throw replyWrongRoom()
  if (row.deleted_at !== null) throw replyDeletedTarget()
  return toReplyToDTO(row)
}

/**
 * Batch-hydrate reply previews for a set of target ids from ONE table in ONE query. Returns a map
 * keyed by TARGET id (distinct ids deduped; null/undefined entries skipped). Zero queries when the
 * page has no replies.
 */
export async function loadReplyTargets(
  sql: Queryable,
  table: ReplyTable,
  replyToIds: ReadonlyArray<string | null | undefined>,
): Promise<Map<string, ReplyToDTO>> {
  const distinct = [...new Set(replyToIds.filter((v): v is string => v != null))]
  if (distinct.length === 0) return new Map()
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
  return new Map(rows.map((r) => [r.id, toReplyToDTO(r)]))
}

/** Convenience over loadReplyTargets for a page of selected rows carrying `reply_to_id`. */
export function replyMapForRows(
  sql: Queryable,
  table: ReplyTable,
  rows: ReadonlyArray<{ reply_to_id: string | null }>,
): Promise<Map<string, ReplyToDTO>> {
  return loadReplyTargets(sql, table, rows.map((r) => r.reply_to_id))
}
