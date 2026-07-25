/**
 * The TABLE-PARAMETERIZED room-scope core shared by chat-repository.drizzle.ts (chat_messages) and
 * dm-repository.drizzle.ts (dm_messages).
 *
 * The two tables are structural twins: dm_messages mirrors chat_messages column-for-column apart from its
 * room reference (thread_id vs cleanup_id/report_id/group_id) and the report-only extras (system payload,
 * @city forward). Every room-scoped READ was therefore written twice — the same keyset cursor anchor, the
 * same around-window, the same one-row seek, the same pin flip, the same pin list — and each copy is a
 * place the other can silently drift. The subtle invariants that drift first are exactly the ones that
 * cost the most to rediscover:
 *   - the `before` anchor's (created_at, id) tuple NEVER leaves the database (a row-valued subquery), so
 *     the driver's millisecond truncation of created_at cannot make same-millisecond rows repeat/skip;
 *   - the anchor EXISTENCE pre-check, which keeps an unknown/foreign cursor falling back to the newest
 *     page instead of an all-NULL filter -> empty page;
 *   - around-mode's `(deleted_at IS NULL OR id = <target>)` exception, which lets a jump target's own
 *     tombstone ride in its window while every other tombstone stays filtered out;
 *   - the pin flip's `(pinned_at IS NULL) = <pinned>` gate, which makes a repeat pin an idempotent no-op
 *     that does NOT refresh pinned_at.
 *
 * ONE definition each lives here, parameterized by a RoomScopeSql descriptor supplying the table, the row
 * alias, the room predicate, the SELECT list, the users join, the per-query side context and the two
 * hydrators. What genuinely DIVERGES stays in the repositories and is deliberately NOT pushed through this
 * seam: the row shape and DTO mapping (system rows, roomKind, @city chips, poll bodies vs the flat dm
 * row), persistence, edit/soft-delete writes (chat has a moderator sender-gate bypass, dm does not), meta
 * lookups, and everything dm-only (threads, peers, read state, blocks).
 *
 * SQL SEMANTICS ARE UNCHANGED from the two originals: identifiers render through postgres.js's `sql(...)`
 * ident helper over closed unions (never string concatenation), values stay parameterized, and every
 * predicate / ORDER BY / LIMIT is equivalent to the copy it replaces. The only textual difference is that
 * idents which used to be bare (`chat_messages`, `cm.created_at`) now render quoted (`"chat_messages"`,
 * `"cm".created_at`) — the same objects, since both spellings are already lower-case.
 */

import { AppError } from "@civfix/shared"
import type { ChatMessageDTO } from "@civfix/shared"
import type { ChatHistoryPage } from "@civfix/shared/interfaces"
import type postgres from "postgres"
import type { Sql } from "../db/client.js"
import { isUuid } from "../db/cursor-helpers.js"
import { aroundLimits, mergeAroundWindow } from "./chat-history-window.js"
import type { ReplyTable } from "./chat-reply-hydration.js"

/** A composable SQL fragment (postgres.js Fragment); what a `sql\`...\`` expression yields. */
type SqlFragment = postgres.Fragment

/** The two room-scoped message tables — the same closed set as chat-reply-hydration's ReplyTable. */
export type RoomTable = ReplyTable

/**
 * The row alias each table is selected through. A CLOSED union rather than a bare string, so the ident
 * positions the core renders can never receive anything but these two literals (the convention the
 * dynamic-SQL guard documents: dynamic identifiers go through `${sql(name)}` over a closed union).
 */
export type RoomAlias = "cm" | "dm"

/** Cap for a room's pin list (both the listPins query and the initial-history `pins` array). */
export const PIN_LIST_CAP = 25

/**
 * The only field the core itself reads off a selected row (both cursor ends). Everything else about the
 * row shape belongs to the owning repository's hydrator/mapper.
 */
export interface RoomScopeRow {
  id: string
}

/**
 * Everything the core needs to run the room-scoped reads for ONE room of ONE table. Built per call by the
 * owning repository (the room id is baked into `scope`), so a chat spec can specialize on its scope column
 * (e.g. the report-only forward column in `columns`) exactly as the hand-written copies did.
 */
export interface RoomScopeSql<Row extends RoomScopeRow, Ctx> {
  /** The room's message table. A trusted internal identifier, rendered via sql(...) as an ident. */
  table: RoomTable
  /** The row alias every query below selects through, matching the alias `from` declares. */
  alias: RoomAlias
  /**
   * The room predicate: `<prefix>.<scope column> = <room id>`. `prefix` is the alias to qualify the
   * column with, or null for the statements that have no alias to qualify it WITH (the anchor
   * pre-check and the pin UPDATE). Values stay parameterized; the column name is a trusted ident.
   */
  scope(prefix: string | null): SqlFragment
  /** The SELECT list for a full row: the table's columns off `alias` + the sender columns off `u`. */
  columns: SqlFragment
  /**
   * `FROM <table> <alias> [LEFT] JOIN users u ON u.id = <alias>.sender_id`. The join KIND is part of the
   * divergence: chat LEFT-joins (a report SYSTEM row has no sender), dm inner-joins.
   */
  from: SqlFragment
  /**
   * Per-query side context, resolved IN PARALLEL with the row fetch (chat: the report's jurisdiction for
   * the @city chip — constant per report; dm: nothing, so an already-resolved null).
   */
  context(): Promise<Ctx>
  /** Batch hydration for a page of rows (attachments/reactions/mentions/reply previews [+ polls]). */
  hydratePage(rows: Row[], viewerUserId: string | null, ctx: Ctx): Promise<ChatMessageDTO[]>
  /**
   * Single-row hydration for a one-row seek. Owns its own context resolution (the single-id loaders and
   * the context query share one Promise.all in both repositories).
   */
  hydrateOne(row: Row, viewerUserId: string | null): Promise<ChatMessageDTO>
}

/**
 * Newest-first page of a room's live messages, optionally before a cursor id or centered on a target.
 *
 * The `before` cursor resolves to a keyset anchor whose (created_at, id) tuple deliberately NEVER leaves
 * the database (a row-valued subquery on the anchor id): round-tripping created_at through the driver
 * truncates microseconds to milliseconds (postgres-js serializes Date params via a JS Date), so
 * same-millisecond messages could repeat/skip across pages. The existence pre-check preserves the
 * stale-cursor fallback (an unknown/foreign-room `before` returns the newest page; without it the NULL-row
 * subquery would instead produce an all-NULL filter => empty page). No deleted_at filter on the anchor:
 * it is used solely for its keyset position, so a tombstoned cursor id must still page correctly. The
 * isUuid guard keeps `id = ${before}` from raising 22P02 -> 500 on a non-uuid string (DmHistoryQuerySchema
 * validates the uuid, ChatHistoryQuerySchema does not, so the guard belongs at the seam).
 */
export async function roomHistory<Row extends RoomScopeRow, Ctx>(
  sql: Sql,
  spec: RoomScopeSql<Row, Ctx>,
  before: string | undefined,
  limit: number,
  viewerUserId: string | null,
  around?: string,
): Promise<ChatHistoryPage> {
  // Around-mode (P2 2.4): a center-window fetch is a separate path; the before-mode fast path below stays
  // untouched. The route schemas reject around+before together, so `before` is undefined here.
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
 * Around-mode history (P2 2.4): a window of ceil(limit/2) rows at-or-older than the target (the target row
 * INCLUDED) + floor(limit/2) strictly newer, merged newest-first — the same ordering as a before-mode
 * page. See chat-history-window.ts for the window/cursor semantics (nextCursor = older end, prevCursor =
 * newer end, each null when that side reaches the edge).
 *
 * The anchor lookup is scoped to THIS room and — unlike the `before` anchor — INCLUDES soft-deleted
 * targets: jumping to a deleted message's position is valid, and its tombstone rides in the window (every
 * OTHER deleted row stays filtered out, as in before-mode). A missing/foreign-room id is a 404: a jump
 * target the client explicitly named must exist, whereas an unknown `before` cursor just falls back to the
 * newest page. The anchor tuple stays entirely in SQL for the same microsecond reason as `before` — here a
 * truncated round-trip would eject the target from its own <=-window.
 */
export async function roomHistoryAround<Row extends RoomScopeRow, Ctx>(
  sql: Sql,
  spec: RoomScopeSql<Row, Ctx>,
  around: string,
  limit: number,
  viewerUserId: string | null,
): Promise<ChatHistoryPage> {
  // Non-uuid ids can never match; short-circuit to the same 404 (avoids a 22P02 cast error -> 500).
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
  // Fetch +1 on EACH side so has-more resolves independently per end.
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
 * One LIVE message of this room, fully hydrated for the viewer. Null when the id is unknown, belongs to
 * another room, or is soft-deleted — the caller maps that to 404/403 without distinguishing them.
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
 * Pin/unpin flip (P3). The WHERE gates room scope + live row + non-system kind + an ACTUAL state change
 * (`(pinned_at IS NULL) = pin` matches unpinned rows when pinning and pinned rows when unpinning), so a
 * repeat pin is a no-op that keeps the original pinned_at. The current DTO is then re-read (hydrated like
 * any history row) regardless of whether the UPDATE matched — idempotent calls return the same payload.
 * Authorization (who may pin) lives in the routes via the chat-powers resolver.
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

/**
 * The room's pins, newest-pin first over the partial pin index, hydrated like a history page and capped at
 * PIN_LIST_CAP. Tombstoned rows never surface.
 */
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
