/**
 * A body-less target gets an empty excerpt and the client renders a kind-based descriptor from `kind`,
 * so localization stays client-side. A tombstoned target also gets an empty excerpt: the original text
 * must not survive its deletion through the reply preview. `from` is null for a sender-less SYSTEM row
 * and for a deleted sender account.
 *
 * The machine subcodes ride `fields.code` because ErrorCode is a closed enum; clients key off
 * httpStatus + fields.code.
 */

import { AppError, ErrorCode } from "@civfix/shared"
import type { ReplyToDTO } from "@civfix/shared"
import type { Queryable } from "../db/client.js"
import { isUuid } from "../db/cursor-helpers.js"
import {
  findReplyTarget,
  loadReplyTargetRows,
  type ReplyRoomScope,
  type ReplyTable,
  type ReplyTargetRow,
} from "./reply-targets-repository.drizzle.js"

export const REPLY_EXCERPT_MAX = 120

export const replyWrongRoom = (): AppError =>
  new AppError(ErrorCode.VALIDATION, "The message you're replying to isn't in this conversation.", {
    fields: { code: "reply_wrong_room" },
  })

export const replyDeletedTarget = (): AppError =>
  new AppError(ErrorCode.VALIDATION, "The message you're replying to was deleted.", {
    fields: { code: "reply_deleted_target" },
  })

/** A bar-chart glyph so a quoted poll reads as a poll. */
const POLL_EXCERPT_PREFIX = "\u{1F4CA} "

function liveExcerpt(row: Pick<ReplyTargetRow, "kind" | "body">): string {
  const text = row.kind === "poll" ? POLL_EXCERPT_PREFIX + (row.body ?? "") : (row.body ?? "")
  return text.slice(0, REPLY_EXCERPT_MAX)
}

function toReplyToDTO(row: ReplyTargetRow): ReplyToDTO {
  const deleted = row.deleted_at !== null
  const from =
    row.sender_id !== null && row.sender_deleted_at === null
      ? { id: row.sender_id, displayName: row.sender_display_name ?? "" }
      : null
  return {
    id: row.id,
    from,
    excerpt: deleted ? "" : liveExcerpt(row),
    kind: row.kind,
    ...(deleted ? { deleted: true } : {}),
  }
}

/**
 * A missing row and a wrong-room row are indistinguishable to the sender, so both throw
 * reply_wrong_room; a non-uuid id can never match and short-circuits the same way instead of hitting a
 * 22P02 cast error (a 500).
 */
export async function assertReplyTarget(
  sql: Queryable,
  table: ReplyTable,
  scope: ReplyRoomScope,
  replyToId: string,
): Promise<ReplyToDTO> {
  if (!isUuid(replyToId)) throw replyWrongRoom()
  const row = await findReplyTarget(sql, table, scope, replyToId)
  if (!row || row.room_ref !== scope.id) throw replyWrongRoom()
  if (row.deleted_at !== null) throw replyDeletedTarget()
  return toReplyToDTO(row)
}

/** Keyed by TARGET id. */
async function loadReplyTargets(
  sql: Queryable,
  table: ReplyTable,
  replyToIds: ReadonlyArray<string | null | undefined>,
): Promise<Map<string, ReplyToDTO>> {
  const distinct = [...new Set(replyToIds.filter((v): v is string => v != null))]
  if (distinct.length === 0) return new Map()
  const rows = await loadReplyTargetRows(sql, table, distinct)
  return new Map(rows.map((r) => [r.id, toReplyToDTO(r)]))
}

export function replyMapForRows(
  sql: Queryable,
  table: ReplyTable,
  rows: ReadonlyArray<{ reply_to_id: string | null }>,
): Promise<Map<string, ReplyToDTO>> {
  return loadReplyTargets(
    sql,
    table,
    rows.map((r) => r.reply_to_id),
  )
}
