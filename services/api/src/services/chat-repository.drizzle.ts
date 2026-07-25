
import type { Queryable, Sql } from "../db/client.js"
import { publicAuthorIdentity } from "./public-author.js"
import type {
  ChatMessageDTO,
  ChatMessageKind,
  MediaDTO,
  PollDTO,
  ReactionEmoji,
  ReactionSummaryDTO,
  ReplyToDTO,
  UserMentionDTO,
} from "@civfix/shared"
import type { ChatHistoryPage, PersistChatInput } from "@civfix/shared/interfaces"
import { loadChatReactions, loadChatReactionsFor, toggleChatReaction } from "./chat-reactions.drizzle.js"
import { loadChatMentions, loadChatMentionsFor } from "./chat-mentions.drizzle.js"
import { attachChatMedia, loadChatAttachments } from "./chat-attachments.drizzle.js"
import type { PresignMedia } from "./media-presign.js"
import { mapSystemRow } from "./report-chat-repository.drizzle.js"
import { parseCityMention, effectiveJurisdictionHandle } from "./discussion-mentions.js"
import { assertReplyTarget, replyMapForRows } from "./chat-reply-hydration.js"
import { loadPollsFor } from "./chat-poll-repository.drizzle.js"
import {
  PIN_LIST_CAP,
  roomFindMessage,
  roomHistory,
  roomListPins,
  roomSetPinned,
  type RoomScopeSql,
} from "./chat-room-scope.drizzle.js"

// The report's jurisdiction, resolved ONCE per report-scoped query (it is constant per report). Drives the
// @city `cityMention` chip on report messages. null when the report has no resolved jurisdiction.
export interface ReportCityContext {
  geoid: string
  name: string
  // Effective handle (stored column, else derived from name); null when neither yields a usable handle.
  handle: string | null
}

/**
 * Lightweight per-message metadata for the edit gate ladder (chat-edit-service). Unlike findMessage /
 * findReportMessage this resolves by id ALONE (no room scope, INCLUDING soft-deleted rows) so the caller
 * can distinguish wrong-room (404) / deleted (409) / non-text (422) / stale (window) before touching the
 * row. senderId is null on sender-less SYSTEM rows.
 */
export interface ChatMessageMeta {
  id: string
  cleanupId: string | null
  reportId: string | null
  /** P4: the group room's id when the row is group-scoped (exactly one of the three refs is set). */
  groupId: string | null
  senderId: string | null
  kind: ChatMessageKind
  createdAt: Date
  deletedAt: Date | null
}

export interface ChatRepository {
  insertMessage(input: PersistChatInput, id: string): Promise<ChatMessageDTO>
  /** Resolve edit-gate metadata by message id alone (soft-deleted rows included). Null when unknown. */
  findMessageMeta(messageId: string): Promise<ChatMessageMeta | null>
  history(
    cleanupId: string,
    before: string | undefined,
    limit: number,
    viewerUserId?: string | null,
    /** Around-mode (P2 2.4): center the page on this message id; mutually exclusive with `before`. */
    around?: string,
  ): Promise<ChatHistoryPage>
  findMessage(
    cleanupId: string,
    messageId: string,
    viewerUserId: string | null,
  ): Promise<ChatMessageDTO | null>
  toggleReaction(messageId: string, userId: string, emoji: ReactionEmoji): Promise<boolean>
  /**
   * Edit a cleanup message's body and stamp edited_at = now(), returning the refreshed, fully-hydrated
   * ChatMessageDTO (reactions/mentions/attachments, like a history row). SENDER-ONLY + room-scoped +
   * not-soft-deleted via the UPDATE's WHERE (mirrors dm-repository.editMessage); null when it matched
   * nothing. Authorization gates beyond the WHERE (kind, edit window, membership) live in chat-edit-service.
   */
  editMessage(
    cleanupId: string,
    messageId: string,
    senderId: string,
    body: string,
  ): Promise<ChatMessageDTO | null>
  softDelete(
    cleanupId: string,
    messageId: string,
    senderId: string,
    opts?: SoftDeleteOpts,
  ): Promise<ChatMessageDTO | null>
  /**
   * Pin/unpin a cleanup message (P3). The gated UPDATE flips (pinned_at, pinned_by) only when the row is
   * in THIS room, live (not soft-deleted), a non-system kind, AND the pin state actually changes — so
   * pinning an already-pinned message is an idempotent no-op that does NOT refresh pinned_at. Either way
   * the CURRENT fully-hydrated DTO is re-read and returned (null when the message is missing from the
   * room or tombstoned). Authorization (who may pin) lives in the route via the chat-powers resolver.
   */
  setPinned(
    cleanupId: string,
    messageId: string,
    userId: string,
    pinned: boolean,
  ): Promise<ChatMessageDTO | null>
  /** Report-room twin of setPinned (scoped on report_id). */
  setReportPinned(
    reportId: string,
    messageId: string,
    userId: string,
    pinned: boolean,
  ): Promise<ChatMessageDTO | null>
  /**
   * The room's pinned messages as fully-hydrated DTOs, newest-pin first (pinned_at DESC), capped at
   * PIN_LIST_CAP. Rides the partial pin index; tombstoned rows never surface.
   */
  listPins(cleanupId: string, viewerUserId: string | null): Promise<ChatMessageDTO[]>
  /** Report-room twin of listPins (scoped on report_id). */
  listReportPins(reportId: string, viewerUserId: string | null): Promise<ChatMessageDTO[]>
  reportHistory(
    reportId: string,
    before: string | undefined,
    limit: number,
    viewerUserId?: string | null,
    /** Around-mode (P2 2.4): center the page on this message id; mutually exclusive with `before`. */
    around?: string,
  ): Promise<ChatHistoryPage>
  findReportMessage(
    reportId: string,
    messageId: string,
    viewerUserId: string | null,
  ): Promise<ChatMessageDTO | null>
  /** Report-room twin of editMessage (same WHERE gate, scoped on report_id). */
  editReportMessage(
    reportId: string,
    messageId: string,
    senderId: string,
    body: string,
  ): Promise<ChatMessageDTO | null>
  softDeleteReport(
    reportId: string,
    messageId: string,
    senderId: string,
    opts?: SoftDeleteOpts,
  ): Promise<ChatMessageDTO | null>
  countReportMessages(reportId: string): Promise<number>
  /** Group-room twin of history (P4, scoped on group_id). */
  groupHistory(
    groupId: string,
    before: string | undefined,
    limit: number,
    viewerUserId?: string | null,
    around?: string,
  ): Promise<ChatHistoryPage>
  /** Group-room twin of findMessage (scoped on group_id). */
  findGroupMessage(
    groupId: string,
    messageId: string,
    viewerUserId: string | null,
  ): Promise<ChatMessageDTO | null>
  /** Group-room twin of editMessage (same WHERE gate, scoped on group_id; P4 4.4). */
  editGroupMessage(
    groupId: string,
    messageId: string,
    senderId: string,
    body: string,
  ): Promise<ChatMessageDTO | null>
  /** Group-room twin of softDelete (scoped on group_id; same SoftDeleteOpts moderator bypass). */
  softDeleteGroup(
    groupId: string,
    messageId: string,
    senderId: string,
    opts?: SoftDeleteOpts,
  ): Promise<ChatMessageDTO | null>
  /** Group-room twin of setPinned (scoped on group_id). */
  setGroupPinned(
    groupId: string,
    messageId: string,
    userId: string,
    pinned: boolean,
  ): Promise<ChatMessageDTO | null>
  /** Group-room twin of listPins (scoped on group_id). */
  listGroupPins(groupId: string, viewerUserId: string | null): Promise<ChatMessageDTO[]>
}

/**
 * P3 Task 3.5 delete-others: `bypassSenderGate: true` drops the `sender_id = actor` predicate from the
 * soft-delete UPDATE so a MODERATOR (per the chat-powers resolver) can tombstone someone else's message.
 * The default (absent/false) keeps the sender-only gate byte-identical. Even when bypassing, sender-less
 * SYSTEM rows stay untouchable (`sender_id IS NOT NULL`) — moderation never erases system history.
 */
export interface SoftDeleteOpts {
  bypassSenderGate?: boolean
}

/**
 * Cap for a room's pin list (both the listPins query and the initial-history `pins` array). Defined with
 * the shared room-scope core that applies it and re-exported here, which is where every consumer (dm
 * repositories, routes, tests) already imports it from.
 */
export { PIN_LIST_CAP }

interface ChatRowSelect {
  id: string
  cleanup_id: string | null
  report_id: string | null
  // P4: group room scope; exactly one of cleanup_id / report_id / group_id is set per row.
  group_id: string | null
  // Nullable: a report SYSTEM message has no author (see report-chat-repository.drizzle.ts). Author
  // columns below are correspondingly nullable because the report history LEFT JOINs users.
  sender_id: string | null
  body: string | null
  kind: ChatMessageKind
  attachments: unknown[] | null
  created_at: Date
  edited_at: Date | null
  deleted_at: Date | null
  // Reply threading (P2): the quoted message's id (same table), or NULL for a plain message.
  reply_to_id: string | null
  // Pin state (P3): when the message was pinned to its room; NULL = not pinned.
  pinned_at: Date | null
  // System-message payload; NULL on every non-system row. Only ever populated for report system rows.
  system_status: string | null
  system_kind: string | null
  system_body: string | null
  sender_display_name: string | null
  sender_handle: string | null
  sender_bio: string | null
  sender_avatar_url: string | null
  sender_deleted_at: Date | null
  // REPORT rows only (D-C4): true when this message has a report_message_forwards row whose forwarded_at is
  // set (the "Forwarded to city" pill). Absent/undefined on cleanup/dm queries, which never add the join.
  forwarded_to_city?: boolean
}

function toMessageDTO(
  r: ChatRowSelect,
  reactions: ReactionSummaryDTO[],
  mentions: UserMentionDTO[],
  viewerUserId?: string | null,
  clientId?: string,
  attachments: MediaDTO[] = [],
  // REPORT scope only: the report's resolved jurisdiction (constant per report), used to compute the @city
  // `cityMention` chip. Omitted/null for cleanup/dm and for reports with no jurisdiction.
  reportCity?: ReportCityContext | null,
  // Hydrated reply preview for r.reply_to_id (chat-reply-hydration). Only meaningful when the row IS a
  // reply; null renders the quote header as unavailable.
  replyTo?: ReplyToDTO | null,
  // P6 poll payload for a kind:"poll" row (chat-poll-repository loadPollsFor). Absent for every other
  // kind and for a tombstoned poll (a deleted poll hydrates as a plain tombstone, no poll body).
  poll?: PollDTO | null,
): ChatMessageDTO {
  // A report SYSTEM message has no author (sender_id NULL); delegate to the pure system mapper so its
  // from:null / kind:"system" / structured system payload render in history + broadcasts. Only report
  // rows can reach this branch (cleanup/dm rows always carry a sender), so cleanup/dm mapping is
  // unchanged. system_status is guaranteed non-null on a real system row. System rows carry no @city
  // forward (they have no body a user typed), so forwardedToCity/cityMention stay absent for them.
  if (r.sender_id === null && r.report_id !== null) {
    return mapSystemRow({
      id: r.id,
      report_id: r.report_id,
      body: r.body,
      created_at: r.created_at,
      system_status: r.system_status ?? "",
      system_kind: r.system_kind,
      system_body: r.system_body,
    })
  }
  const author = publicAuthorIdentity({
    id: r.sender_id!,
    displayName: r.sender_display_name ?? "",
    handle: r.sender_handle,
    avatarUrl: r.sender_avatar_url,
    deletedAt: r.sender_deleted_at,
  })
  const isReport = r.report_id !== null
  const isGroup = r.group_id !== null
  return {
    id: r.id,
    // `cleanupId` is the wire field for "room id" across all kinds (legacy name); roomKind disambiguates.
    cleanupId: r.cleanup_id ?? r.report_id ?? r.group_id!,
    ...(isReport ? { roomKind: "report" as const } : {}),
    ...(isGroup ? { roomKind: "group" as const } : {}),
    from: {
      id: r.sender_id!,
      name: author.name,
      handle: author.handle,
      bio: author.deleted ? null : r.sender_bio,
      avatar: author.avatar,
      ...(author.avatarUrl !== undefined ? { avatarUrl: author.avatarUrl } : {}),
      followers: 0,
      following: 0,
      isFollowing: false,
      ...(author.deleted ? { deleted: true } : {}),
    },
    ...(r.body !== null ? { body: r.body } : {}),
    kind: r.kind,
    attachments,
    reactions,
    mentions,
    createdAt: r.created_at.toISOString(),
    ...(r.edited_at !== null ? { editedAt: r.edited_at.toISOString() } : {}),
    ...(r.deleted_at !== null ? { deletedAt: r.deleted_at.toISOString() } : {}),
    // Reply threading (P2): the target id rides through verbatim; the denormalized preview is whatever
    // hydration resolved for it (null = target unavailable, client renders a generic quote header).
    ...(r.reply_to_id !== null ? { replyToId: r.reply_to_id, replyTo: replyTo ?? null } : {}),
    // Pinning (P3): pinnedAt rides on every read so history rows and message_update broadcasts agree.
    ...(r.pinned_at != null ? { pinnedAt: r.pinned_at.toISOString() } : {}),
    // Polls (P6): the viewer-aware poll DTO on a kind:"poll" row; absent everywhere else.
    ...(poll != null ? { poll } : {}),
    mine: viewerUserId != null && r.sender_id === viewerUserId,
    // @city forward surfacing (report rows only). forwardedToCity = the pill (an audit row for this message
    // has forwarded_at set). cityMention = the tinted chip when the body @mentions the report's jurisdiction
    // handle; `forwarded` mirrors forwardedToCity. cleanup/dm rows omit both (no report jurisdiction, no
    // forward column). A deleted (tombstoned) row still reports its historical forward state.
    ...(isReport ? cityForwardFields(r, reportCity) : {}),
    ...(clientId !== undefined ? { clientId } : {}),
  }
}

// Compute the report-only forwardedToCity + cityMention fields. forwardedToCity comes straight from the
// per-row EXISTS column. cityMention is present only when the report has a jurisdiction with a usable handle
// AND the body actually @mentions it (parseCityMention), matching the retired discussion contract; its
// `forwarded` flag mirrors forwardedToCity. Returns a partial spread onto the DTO. Exported (pure, DB-free)
// so the report @city surfacing is unit-tested without a database, like mapSystemRow.
export function cityForwardFields(
  r: Pick<ChatRowSelect, "body" | "forwarded_to_city">,
  reportCity: ReportCityContext | null | undefined,
): Pick<ChatMessageDTO, "forwardedToCity" | "cityMention"> {
  const forwardedToCity = r.forwarded_to_city === true
  const body = r.body ?? ""
  const handle = reportCity != null ? effectiveJurisdictionHandle(reportCity) : null
  const cityMention =
    reportCity != null && handle !== null && parseCityMention(body, handle) !== null
      ? {
          // handle is non-null in this branch (parseCityMention only matches a real handle).
          handle,
          geoid: reportCity.geoid,
          name: reportCity.name,
          forwarded: forwardedToCity,
        }
      : null
  return { forwardedToCity, cityMention }
}

// The per-row "was this message forwarded to the city?" column. REPORT scope only: an EXISTS over
// report_message_forwards for this message with a stamped forwarded_at. For cleanup/dm scope we emit a
// constant FALSE (those rows never have forward audit rows) so the SELECT column list stays uniform without
// adding a join to the cleanup/dm path. Aliased forwarded_to_city to match ChatRowSelect.
function forwardedColumn(sql: Queryable, alias: string) {
  // alias is a trusted internal identifier ("cm" or a CTE name), rendered via sql(...) as an escaped ident.
  return sql`EXISTS (
    SELECT 1 FROM report_message_forwards f
    WHERE f.message_id = ${sql(alias)}.id AND f.forwarded_at IS NOT NULL
  ) AS forwarded_to_city`
}

function chatColumns(sql: Queryable, includeForward: boolean) {
  const forward = includeForward ? sql`, ${forwardedColumn(sql, "cm")}` : sql``
  return sql`
    cm.id,
    cm.cleanup_id,
    cm.report_id,
    cm.group_id,
    cm.sender_id,
    cm.body,
    cm.kind,
    cm.attachments,
    cm.created_at,
    cm.edited_at,
    cm.deleted_at,
    cm.reply_to_id,
    cm.pinned_at,
    cm.system_status,
    cm.system_kind,
    cm.system_body,
    u.display_name AS sender_display_name,
    u.handle AS sender_handle,
    u.bio AS sender_bio,
    u.avatar_url AS sender_avatar_url,
    u.deleted_at AS sender_deleted_at
    ${forward}
  `
}

function selectChatRowFrom(tag: Queryable, cte: string, includeForward: boolean) {
  const forward = includeForward ? tag`, ${forwardedColumn(tag, cte)}` : tag``
  return tag`
    SELECT
      ${tag(cte)}.id,
      ${tag(cte)}.cleanup_id,
      ${tag(cte)}.report_id,
      ${tag(cte)}.group_id,
      ${tag(cte)}.sender_id,
      ${tag(cte)}.body,
      ${tag(cte)}.kind,
      ${tag(cte)}.attachments,
      ${tag(cte)}.created_at,
      ${tag(cte)}.edited_at,
      ${tag(cte)}.deleted_at,
      ${tag(cte)}.reply_to_id,
      ${tag(cte)}.pinned_at,
      ${tag(cte)}.system_status,
      ${tag(cte)}.system_kind,
      ${tag(cte)}.system_body,
      u.display_name AS sender_display_name,
      u.handle AS sender_handle,
      u.bio AS sender_bio,
      u.avatar_url AS sender_avatar_url,
      u.deleted_at AS sender_deleted_at
      ${forward}
    FROM ${tag(cte)}
    LEFT JOIN users u ON u.id = ${tag(cte)}.sender_id
  `
}

export function makeDrizzleChatRepository(sql: Sql, presign?: PresignMedia): ChatRepository {
  type RoomScope = { column: "cleanup_id" | "report_id" | "group_id"; id: string }

  // scope.column is a trusted internal identifier from the closed union above, rendered as an ident.
  // This is the UN-ALIASED form, for the statements with no row alias to qualify the column with (the
  // edit/pin/delete UPDATEs and the cursor-anchor probes); the aliased form rides on roomSql below.
  const anchorScope = (scope: RoomScope) => sql`${sql(scope.column)} = ${scope.id}`

  // The report's jurisdiction (geoid/name/handle) is constant per report, so we resolve it ONCE per
  // report-scoped query to drive the @city cityMention chip. cleanup/dm scope skips this entirely (returns
  // null) so their mapping is unchanged and no extra query runs. Returns null when the report has no
  // resolved jurisdiction (nothing to @mention).
  async function resolveReportCity(scope: RoomScope): Promise<ReportCityContext | null> {
    if (scope.column !== "report_id") return null
    const rows = await sql<{ geoid: string; name: string | null; handle: string | null }[]>`
      SELECT j.geoid, j.name, j.handle
      FROM reports r
      JOIN jurisdictions j ON j.geoid = r.jurisdiction_geoid
      WHERE r.id = ${scope.id}
      LIMIT 1
    `
    const row = rows[0]
    if (!row) return null
    return { geoid: row.geoid, name: row.name ?? row.geoid, handle: row.handle }
  }

  /**
   * Batch-hydrate a page of selected rows into wire DTOs: attachments + reactions + mentions + reply
   * previews in ONE grouped query each. Shared by the before-mode page and the around-mode window so
   * both hydrate identically (Task 2.3 reply hydration included).
   */
  async function hydrateRows(
    page: ChatRowSelect[],
    viewerUserId: string | null,
    reportCity: ReportCityContext | null,
  ): Promise<ChatMessageDTO[]> {
    const ids = page.map((r) => r.id)
    // Poll hydration (P6): only LIVE poll-kind rows attach a poll DTO — a tombstoned poll hydrates as a
    // plain deleted row (its question must not survive deletion).
    const pollIds = page.filter((r) => r.kind === "poll" && r.deleted_at === null).map((r) => r.id)
    const [attachmentsByMessage, reactionsByMessage, mentionsByMessage, replyByTarget, pollsByMessage] =
      await Promise.all([
        presign ? loadChatAttachments(sql, ids, presign) : Promise.resolve(new Map<string, MediaDTO[]>()),
        loadChatReactionsFor(sql, ids, viewerUserId),
        loadChatMentionsFor(sql, ids),
        // Reply previews: ONE id=ANY(...) fetch over the SAME table for the page's distinct targets.
        replyMapForRows(sql, "chat_messages", page),
        loadPollsFor(sql, pollIds, viewerUserId),
      ])
    return page.map((r) =>
      toMessageDTO(
        r,
        reactionsByMessage.get(r.id) ?? [],
        mentionsByMessage.get(r.id) ?? [],
        viewerUserId,
        undefined,
        attachmentsByMessage.get(r.id) ?? [],
        reportCity,
        r.reply_to_id !== null ? replyByTarget.get(r.reply_to_id) ?? null : null,
        pollsByMessage.get(r.id) ?? null,
      ),
    )
  }

  /**
   * Single-row hydration for the one-row seek: the same inputs hydrateRows batches, but on the single-id
   * loaders, with the report jurisdiction resolved in the SAME Promise.all.
   */
  async function hydrateRow(
    scope: RoomScope,
    row: ChatRowSelect,
    viewerUserId: string | null,
  ): Promise<ChatMessageDTO> {
    const pollIds = row.kind === "poll" && row.deleted_at === null ? [row.id] : []
    const [reactions, mentions, attachmentsByMessage, reportCity, replyByTarget, pollsByMessage] =
      await Promise.all([
        loadChatReactions(sql, row.id, viewerUserId),
        loadChatMentions(sql, row.id),
        presign ? loadChatAttachments(sql, [row.id], presign) : Promise.resolve(new Map<string, MediaDTO[]>()),
        resolveReportCity(scope),
        replyMapForRows(sql, "chat_messages", [row]),
        loadPollsFor(sql, pollIds, viewerUserId),
      ])
    return toMessageDTO(
      row,
      reactions,
      mentions,
      viewerUserId,
      undefined,
      attachmentsByMessage.get(row.id) ?? [],
      reportCity,
      row.reply_to_id !== null ? replyByTarget.get(row.reply_to_id) ?? null : null,
      pollsByMessage.get(row.id) ?? null,
    )
  }

  /**
   * The descriptor the shared room-scope core (chat-room-scope.drizzle.ts, also bound by the dm
   * repository) reads this table through. Built PER CALL because the chat side specializes per scope:
   * only report rows carry the @city forward column and a jurisdiction context. The users join is a LEFT
   * join — a report SYSTEM row has no sender.
   */
  function roomSql(scope: RoomScope): RoomScopeSql<ChatRowSelect, ReportCityContext | null> {
    const isReport = scope.column === "report_id"
    return {
      table: "chat_messages",
      alias: "cm",
      scope: (prefix) =>
        prefix === null ? anchorScope(scope) : sql`${sql(prefix)}.${sql(scope.column)} = ${scope.id}`,
      columns: chatColumns(sql, isReport),
      from: sql`FROM chat_messages cm LEFT JOIN users u ON u.id = cm.sender_id`,
      context: () => resolveReportCity(scope),
      hydratePage: hydrateRows,
      hydrateOne: (row, viewerUserId) => hydrateRow(scope, row, viewerUserId),
    }
  }

  /**
   * Newest-first page of the room's live messages, or — with `around` — a window centered on a target
   * message. Both modes (the keyset cursor anchor, the around window, their cursors) live in the shared
   * core; see chat-room-scope.drizzle.ts for the semantics the chat and dm repositories now share.
   */
  function historyScoped(
    scope: RoomScope,
    before: string | undefined,
    limit: number,
    viewerUserId: string | null,
    around?: string,
  ): Promise<ChatHistoryPage> {
    return roomHistory(sql, roomSql(scope), before, limit, viewerUserId, around)
  }

  /** One LIVE message of this room, fully hydrated; null when unknown / foreign-room / tombstoned. */
  function findMessageScoped(
    scope: RoomScope,
    messageId: string,
    viewerUserId: string | null,
  ): Promise<ChatMessageDTO | null> {
    return roomFindMessage(sql, roomSql(scope), messageId, viewerUserId)
  }

  async function editScoped(
    scope: RoomScope,
    messageId: string,
    senderId: string,
    body: string,
  ): Promise<ChatMessageDTO | null> {
    // SENDER-ONLY, room-scoped, not-soft-deleted (the softDeleteScoped WHERE gate, but SET body +
    // edited_at). The gate ladder (kind/window/membership) ran in chat-edit-service off findMessageMeta;
    // this WHERE just makes the write itself race-safe. Then re-read via findMessageScoped so the returned
    // DTO is fully hydrated (reactions/mentions/attachments/@city) exactly like a history row — an edit
    // must not blank the bubble's media or chips. Like the dm edit, the id-only seek probes every
    // partition; editing is a rare, deliberate action, so that is acceptable.
    const rows = await sql<{ id: string }[]>`
      UPDATE chat_messages
      SET body = ${body}, edited_at = now()
      WHERE id = ${messageId}
        AND ${anchorScope(scope)}
        AND sender_id = ${senderId}
        AND deleted_at IS NULL
      RETURNING id
    `
    if (!rows[0]) return null
    return findMessageScoped(scope, messageId, senderId)
  }

  /** Idempotent pin/unpin flip + a re-read of the current hydrated DTO (semantics in the shared core). */
  function setPinnedScoped(
    scope: RoomScope,
    messageId: string,
    userId: string,
    pinned: boolean,
  ): Promise<ChatMessageDTO | null> {
    return roomSetPinned(sql, roomSql(scope), messageId, userId, pinned)
  }

  /** The room's pins, newest-pin first over the partial index, hydrated like a history page. */
  function listPinsScoped(scope: RoomScope, viewerUserId: string | null): Promise<ChatMessageDTO[]> {
    return roomListPins(sql, roomSql(scope), viewerUserId)
  }

  async function softDeleteScoped(
    scope: RoomScope,
    messageId: string,
    senderId: string,
    opts?: SoftDeleteOpts,
  ): Promise<ChatMessageDTO | null> {
    const isReport = scope.column === "report_id"
    // Sender gate: default sender-only; a moderator bypass (Task 3.5) still refuses sender-less SYSTEM
    // rows so moderation can never tombstone system history.
    const senderGate = opts?.bypassSenderGate
      ? sql`AND sender_id IS NOT NULL`
      : sql`AND sender_id = ${senderId}`
    const [rows, reportCity] = await Promise.all([
      sql<ChatRowSelect[]>`
        WITH updated AS (
          UPDATE chat_messages
          SET deleted_at = now()
          WHERE id = ${messageId}
            AND ${anchorScope(scope)}
            ${senderGate}
            AND deleted_at IS NULL
          RETURNING id, cleanup_id, report_id, group_id, sender_id, body, kind, attachments, created_at, edited_at, deleted_at, reply_to_id, pinned_at, system_status, system_kind, system_body
        )
        ${selectChatRowFrom(sql, "updated", isReport)}
      `,
      resolveReportCity(scope),
    ])
    const row = rows[0]
    if (!row) return null
    // The tombstone keeps its replyToId + hydrated preview so the message_update broadcast's DTO stays
    // shape-consistent with history rows (clients reconcile in place).
    const replyByTarget = await replyMapForRows(sql, "chat_messages", [row])
    return toMessageDTO(
      row,
      [],
      [],
      senderId,
      undefined,
      [],
      reportCity,
      row.reply_to_id !== null ? replyByTarget.get(row.reply_to_id) ?? null : null,
    )
  }

  return {
    async insertMessage(input: PersistChatInput, id: string): Promise<ChatMessageDTO> {
      const kind: ChatMessageKind = input.kind ?? "text"
      const uploadIds = input.mediaUploadIds ?? []
      const wantsMedia = !!presign && uploadIds.length > 0
      const isReport = input.roomKind === "report"
      const isGroup = input.roomKind === "group"
      // input.cleanupId is the generic "room id" (legacy field name); exactly one scope column is set.
      const cleanupId = isReport || isGroup ? null : input.cleanupId
      const reportId = isReport ? input.cleanupId : null
      const groupId = isGroup ? input.cleanupId : null
      // Reply validation (P2): the target must exist in THIS room and not be tombstoned — 422 with
      // fields.code reply_wrong_room / reply_deleted_target otherwise. Returns the hydrated preview so
      // the ack/broadcast DTO carries replyTo without a re-read. (Validate-then-insert races a
      // concurrent delete of the target; the reply then simply hydrates deleted:true on later reads.)
      const replyTo =
        input.replyToId !== undefined
          ? await assertReplyTarget(
              sql,
              "chat_messages",
              {
                column: isReport ? "report_id" : isGroup ? "group_id" : "cleanup_id",
                id: input.cleanupId,
              },
              input.replyToId,
            )
          : null
      const run = async (q: Queryable) => q<ChatRowSelect[]>`
        WITH inserted AS (
          INSERT INTO chat_messages (id, cleanup_id, report_id, group_id, sender_id, body, kind, attachments, reply_to_id)
          VALUES (
            ${id},
            ${cleanupId},
            ${reportId},
            ${groupId},
            ${input.userId},
            ${input.body},
            ${kind},
            ${input.attachments != null ? sql.json(input.attachments as Parameters<typeof sql.json>[0]) : null},
            ${input.replyToId ?? null}
          )
          RETURNING id, cleanup_id, report_id, group_id, sender_id, body, kind, attachments, created_at, edited_at, deleted_at, reply_to_id, pinned_at, system_status, system_kind, system_body
        )
        ${selectChatRowFrom(q, "inserted", isReport)}
      `
      // For a report send, resolve the jurisdiction so the @city tint (cityMention) renders on the ack/initial
      // broadcast. forwardedToCity reads the audit column, which is FALSE at this instant: the @city forward
      // fires asynchronously (onReportMessage) AFTER this insert, so the row's forwarded_at is stamped later.
      // The pill flips to true on the next history fetch (the audit table is the source of truth).
      const [rows, reportCity] = await Promise.all([
        wantsMedia
          ? sql.begin(async (tx) => {
              const inserted = await run(tx)
              await attachChatMedia(tx, id, uploadIds)
              return inserted
            })
          : run(sql),
        isReport && input.cleanupId
          ? resolveReportCity({ column: "report_id", id: input.cleanupId })
          : Promise.resolve(null),
      ])
      const attachments = wantsMedia ? (await loadChatAttachments(sql, [id], presign!)).get(id) ?? [] : []
      return toMessageDTO(rows[0]!, [], [], input.userId, input.clientId, attachments, reportCity, replyTo)
    },

    async findMessageMeta(messageId: string): Promise<ChatMessageMeta | null> {
      const rows = await sql<
        {
          id: string
          cleanup_id: string | null
          report_id: string | null
          group_id: string | null
          sender_id: string | null
          kind: ChatMessageKind
          created_at: Date
          deleted_at: Date | null
        }[]
      >`
        SELECT id, cleanup_id, report_id, group_id, sender_id, kind, created_at, deleted_at
        FROM chat_messages
        WHERE id = ${messageId}
        LIMIT 1
      `
      const r = rows[0]
      if (!r) return null
      return {
        id: r.id,
        cleanupId: r.cleanup_id,
        reportId: r.report_id,
        groupId: r.group_id,
        senderId: r.sender_id,
        kind: r.kind,
        createdAt: r.created_at,
        deletedAt: r.deleted_at,
      }
    },

    history(
      cleanupId: string,
      before: string | undefined,
      limit: number,
      viewerUserId: string | null = null,
      around?: string,
    ): Promise<ChatHistoryPage> {
      return historyScoped({ column: "cleanup_id", id: cleanupId }, before, limit, viewerUserId, around)
    },

    editMessage(
      cleanupId: string,
      messageId: string,
      senderId: string,
      body: string,
    ): Promise<ChatMessageDTO | null> {
      return editScoped({ column: "cleanup_id", id: cleanupId }, messageId, senderId, body)
    },

    editReportMessage(
      reportId: string,
      messageId: string,
      senderId: string,
      body: string,
    ): Promise<ChatMessageDTO | null> {
      return editScoped({ column: "report_id", id: reportId }, messageId, senderId, body)
    },

    findMessage(
      cleanupId: string,
      messageId: string,
      viewerUserId: string | null,
    ): Promise<ChatMessageDTO | null> {
      return findMessageScoped({ column: "cleanup_id", id: cleanupId }, messageId, viewerUserId)
    },

    toggleReaction(messageId: string, userId: string, emoji: ReactionEmoji): Promise<boolean> {
      return toggleChatReaction(sql, messageId, userId, emoji)
    },

    softDelete(
      cleanupId: string,
      messageId: string,
      senderId: string,
      opts?: SoftDeleteOpts,
    ): Promise<ChatMessageDTO | null> {
      return softDeleteScoped({ column: "cleanup_id", id: cleanupId }, messageId, senderId, opts)
    },

    setPinned(
      cleanupId: string,
      messageId: string,
      userId: string,
      pinned: boolean,
    ): Promise<ChatMessageDTO | null> {
      return setPinnedScoped({ column: "cleanup_id", id: cleanupId }, messageId, userId, pinned)
    },

    setReportPinned(
      reportId: string,
      messageId: string,
      userId: string,
      pinned: boolean,
    ): Promise<ChatMessageDTO | null> {
      return setPinnedScoped({ column: "report_id", id: reportId }, messageId, userId, pinned)
    },

    listPins(cleanupId: string, viewerUserId: string | null): Promise<ChatMessageDTO[]> {
      return listPinsScoped({ column: "cleanup_id", id: cleanupId }, viewerUserId)
    },

    listReportPins(reportId: string, viewerUserId: string | null): Promise<ChatMessageDTO[]> {
      return listPinsScoped({ column: "report_id", id: reportId }, viewerUserId)
    },

    reportHistory(
      reportId: string,
      before: string | undefined,
      limit: number,
      viewerUserId: string | null = null,
      around?: string,
    ): Promise<ChatHistoryPage> {
      return historyScoped({ column: "report_id", id: reportId }, before, limit, viewerUserId, around)
    },

    findReportMessage(
      reportId: string,
      messageId: string,
      viewerUserId: string | null,
    ): Promise<ChatMessageDTO | null> {
      return findMessageScoped({ column: "report_id", id: reportId }, messageId, viewerUserId)
    },

    softDeleteReport(
      reportId: string,
      messageId: string,
      senderId: string,
      opts?: SoftDeleteOpts,
    ): Promise<ChatMessageDTO | null> {
      return softDeleteScoped({ column: "report_id", id: reportId }, messageId, senderId, opts)
    },

    async countReportMessages(reportId: string): Promise<number> {
      const rows = await sql<{ count: number }[]>`
        SELECT COUNT(*)::int AS count FROM chat_messages
        WHERE report_id = ${reportId} AND deleted_at IS NULL
      `
      return rows[0]?.count ?? 0
    },

    groupHistory(
      groupId: string,
      before: string | undefined,
      limit: number,
      viewerUserId: string | null = null,
      around?: string,
    ): Promise<ChatHistoryPage> {
      return historyScoped({ column: "group_id", id: groupId }, before, limit, viewerUserId, around)
    },

    findGroupMessage(
      groupId: string,
      messageId: string,
      viewerUserId: string | null,
    ): Promise<ChatMessageDTO | null> {
      return findMessageScoped({ column: "group_id", id: groupId }, messageId, viewerUserId)
    },

    editGroupMessage(
      groupId: string,
      messageId: string,
      senderId: string,
      body: string,
    ): Promise<ChatMessageDTO | null> {
      return editScoped({ column: "group_id", id: groupId }, messageId, senderId, body)
    },

    softDeleteGroup(
      groupId: string,
      messageId: string,
      senderId: string,
      opts?: SoftDeleteOpts,
    ): Promise<ChatMessageDTO | null> {
      return softDeleteScoped({ column: "group_id", id: groupId }, messageId, senderId, opts)
    },

    setGroupPinned(
      groupId: string,
      messageId: string,
      userId: string,
      pinned: boolean,
    ): Promise<ChatMessageDTO | null> {
      return setPinnedScoped({ column: "group_id", id: groupId }, messageId, userId, pinned)
    },

    listGroupPins(groupId: string, viewerUserId: string | null): Promise<ChatMessageDTO[]> {
      return listPinsScoped({ column: "group_id", id: groupId }, viewerUserId)
    },
  }
}
