/**
 * chat_messages and dm_messages are structural twins, so their room-scoped reads live here once: two
 * copies of the keyset anchor, around-window and pin flip would drift on exactly the invariants that are
 * costliest to rediscover. What genuinely diverges (row shape and DTO mapping, writes, meta lookups and
 * everything dm-only) deliberately stays in the repositories. Identifiers render through `sql(...)` over
 * closed unions, never string concatenation.
 */

import { AppError } from "@civfix/shared"
import type { ChatMessageDTO } from "@civfix/shared"
import type { ChatHistoryPage } from "@civfix/shared/interfaces"
import type postgres from "postgres"
import type { Sql } from "../db/client.js"
import { isUuid } from "../db/cursor-helpers.js"
import { aroundLimits, mergeAroundWindow } from "./chat-history-window.js"
import type { ReplyTable } from "./chat-reply-hydration.js"

type SqlFragment = postgres.Fragment

export type RoomTable = ReplyTable

/**
 * A closed union rather than a bare string, so the ident positions the core renders can never receive
 * anything but these two literals (the dynamic-SQL guard's convention).
 */
export type RoomAlias = "cm" | "dm"

export const PIN_LIST_CAP = 25

/** Everything else about the row shape belongs to the owning repository's hydrator. */
export interface RoomScopeRow {
  id: string
}

/**
 * Built per call by the owning repository with the room id baked into `scope`, so a chat spec can
 * specialize on its scope column (e.g. the report-only forward column in `columns`).
 */
export interface RoomScopeSql<Row extends RoomScopeRow, Ctx> {
  /** A trusted internal identifier, rendered via sql(...) as an ident. */
  table: RoomTable
  alias: RoomAlias
  /**
   * `prefix` is null for the statements with no alias to qualify the column with (the anchor pre-check
   * and the pin UPDATE).
   */
  scope(prefix: string | null): SqlFragment
  columns: SqlFragment
  /** Chat LEFT-joins users because a report SYSTEM row has no sender; dm inner-joins. */
  from: SqlFragment
  /** Resolved in parallel with the row fetch (chat: the report's jurisdiction for the @city chip). */
  context(): Promise<Ctx>
  hydratePage(rows: Row[], viewerUserId: string | null, ctx: Ctx): Promise<ChatMessageDTO[]>
  /** Resolves its own context so the single-id loaders and the context query share one Promise.all. */
  hydrateOne(row: Row, viewerUserId: string | null): Promise<ChatMessageDTO>
}

/**
 * The `before` anchor's (created_at, id) tuple deliberately never leaves the database (a row-valued
 * subquery): postgres-js round-trips created_at through a JS Date, truncating microseconds, so
 * same-millisecond messages could repeat or skip across pages. The existence pre-check keeps an
 * unknown or foreign-room `before` falling back to the newest page instead of an all-NULL filter and
 * an empty page. The anchor has no deleted_at filter: it is used only for its keyset position, so a
 * tombstoned cursor id must still page correctly. The isUuid guard keeps a non-uuid string from
 * raising 22P02 (a 500): ChatHistoryQuerySchema does not validate the uuid, so the guard belongs here.
 */
export async function roomHistory<Row extends RoomScopeRow, Ctx>(
  sql: Sql,
  spec: RoomScopeSql<Row, Ctx>,
  before: string | undefined,
  limit: number,
  viewerUserId: string | null,
  around?: string,
): Promise<ChatHistoryPage> {
  // The route schemas reject around+before together, so `before` is undefined on this path.
  if (around !== undefined) return roomHistoryAround(sql, spec, around, limit, viewerUserId)

  const alias = sql(spec.alias)
  let cursorFilter = sql``
  if (before !== undefined && isUuid(before)) {
    const anchorRows = await sql<{ id: string }[]>`
      SELECT id FROM ${sql(spec.table)}
      WHERE id = ${before} AND ${spec.scope(null)}
      LIMIT 1
    `
    if (anchorRows[0]) {
      cursorFilter = sql`
        AND (${alias}.created_at, ${alias}.id) < (
          SELECT a.created_at, a.id
          FROM ${sql(spec.table)} a
          WHERE a.id = ${before} AND ${spec.scope("a")}
        )
      `
    }
  }

  const [rows, ctx] = await Promise.all([
    sql<Row[]>`
      SELECT ${spec.columns}
      ${spec.from}
      WHERE ${spec.scope(spec.alias)}
        AND ${alias}.deleted_at IS NULL
        ${cursorFilter}
      ORDER BY ${alias}.created_at DESC, ${alias}.id DESC
      LIMIT ${limit + 1}
    `,
    spec.context(),
  ])
  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  const items = await spec.hydratePage(page, viewerUserId, ctx)
  const last = page[page.length - 1]
  const nextCursor = hasMore && last ? last.id : null
  return { items, nextCursor }
}

/**
 * The anchor lookup includes soft-deleted targets: jumping to a deleted message's position is valid
 * and its tombstone rides in the window, while every other deleted row stays filtered out. A missing
 * or foreign-room id is a 404, because a jump target the client named must exist, whereas an unknown
 * `before` cursor just falls back to the newest page. The anchor tuple stays in SQL for the same
 * microsecond reason as `before`; here a truncated round-trip would eject the target from its window.
 */
export async function roomHistoryAround<Row extends RoomScopeRow, Ctx>(
  sql: Sql,
  spec: RoomScopeSql<Row, Ctx>,
  around: string,
  limit: number,
  viewerUserId: string | null,
): Promise<ChatHistoryPage> {
  // A non-uuid id can never match; the short-circuit avoids a 22P02 cast error (a 500).
  if (!isUuid(around)) throw AppError.notFound("Message not found")
  const anchorRows = await sql<{ id: string }[]>`
    SELECT id FROM ${sql(spec.table)}
    WHERE id = ${around} AND ${spec.scope(null)}
    LIMIT 1
  `
  if (!anchorRows[0]) throw AppError.notFound("Message not found")
  const anchorTuple = sql`(
    SELECT a.created_at, a.id
    FROM ${sql(spec.table)} a
    WHERE a.id = ${around} AND ${spec.scope("a")}
  )`

  const limits = aroundLimits(limit)
  const alias = sql(spec.alias)
  const [olderDesc, newerAsc, ctx] = await Promise.all([
    sql<Row[]>`
      SELECT ${spec.columns}
      ${spec.from}
      WHERE ${spec.scope(spec.alias)}
        AND (${alias}.deleted_at IS NULL OR ${alias}.id = ${around})
        AND (${alias}.created_at, ${alias}.id) <= ${anchorTuple}
      ORDER BY ${alias}.created_at DESC, ${alias}.id DESC
      LIMIT ${limits.olderLimit + 1}
    `,
    sql<Row[]>`
      SELECT ${spec.columns}
      ${spec.from}
      WHERE ${spec.scope(spec.alias)}
        AND ${alias}.deleted_at IS NULL
        AND (${alias}.created_at, ${alias}.id) > ${anchorTuple}
      ORDER BY ${alias}.created_at ASC, ${alias}.id ASC
      LIMIT ${limits.newerLimit + 1}
    `,
    spec.context(),
  ])
  const { rows, hasOlder, hasNewer } = mergeAroundWindow(olderDesc, newerAsc, limits)
  const items = await spec.hydratePage(rows, viewerUserId, ctx)
  return {
    items,
    nextCursor: hasOlder ? rows[rows.length - 1]!.id : null,
    prevCursor: hasNewer ? rows[0]!.id : null,
  }
}

/**
 * Null when the id is unknown, belongs to another room, or is soft-deleted; the caller maps all three to
 * the same answer without distinguishing them.
 */
export async function roomFindMessage<Row extends RoomScopeRow, Ctx>(
  sql: Sql,
  spec: RoomScopeSql<Row, Ctx>,
  messageId: string,
  viewerUserId: string | null,
): Promise<ChatMessageDTO | null> {
  const alias = sql(spec.alias)
  const rows = await sql<Row[]>`
    SELECT ${spec.columns}
    ${spec.from}
    WHERE ${alias}.id = ${messageId} AND ${spec.scope(spec.alias)} AND ${alias}.deleted_at IS NULL
    LIMIT 1
  `
  const row = rows[0]
  if (!row) return null
  return spec.hydrateOne(row, viewerUserId)
}

/**
 * `(pinned_at IS NULL) = pinned` only matches an actual state change, so a repeat pin is a no-op that
 * keeps the original pinned_at, and the re-read returns the same payload either way. Who may pin is
 * decided in the routes via the chat-powers resolver.
 */
export async function roomSetPinned<Row extends RoomScopeRow, Ctx>(
  sql: Sql,
  spec: RoomScopeSql<Row, Ctx>,
  messageId: string,
  userId: string,
  pinned: boolean,
): Promise<ChatMessageDTO | null> {
  await sql`
    UPDATE ${sql(spec.table)}
    SET pinned_at = CASE WHEN ${pinned} THEN now() END,
        pinned_by = CASE WHEN ${pinned} THEN ${userId}::uuid END
    WHERE id = ${messageId}
      AND ${spec.scope(null)}
      AND deleted_at IS NULL
      AND kind <> 'system'
      AND (pinned_at IS NULL) = ${pinned}
  `
  return roomFindMessage(sql, spec, messageId, userId)
}

export async function roomListPins<Row extends RoomScopeRow, Ctx>(
  sql: Sql,
  spec: RoomScopeSql<Row, Ctx>,
  viewerUserId: string | null,
): Promise<ChatMessageDTO[]> {
  const alias = sql(spec.alias)
  const [rows, ctx] = await Promise.all([
    sql<Row[]>`
      SELECT ${spec.columns}
      ${spec.from}
      WHERE ${spec.scope(spec.alias)}
        AND ${alias}.pinned_at IS NOT NULL
        AND ${alias}.deleted_at IS NULL
      ORDER BY ${alias}.pinned_at DESC, ${alias}.id DESC
      LIMIT ${PIN_LIST_CAP}
    `,
    spec.context(),
  ])
  return spec.hydratePage(rows, viewerUserId, ctx)
}
