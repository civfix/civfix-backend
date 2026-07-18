
import type { Queryable, Sql } from "../db/client.js"
import { publicAuthorIdentity } from "./public-author.js"
import type {
  ChatMessageDTO,
  ChatMessageKind,
  MediaDTO,
  ReactionEmoji,
  ReactionSummaryDTO,
  ReplyToDTO,
  UserMentionDTO,
} from "@civfix/shared"
import type { ChatHistoryPage, PersistChatInput } from "@civfix/shared/interfaces"
import { loadChatReactions, loadChatReactionsFor, toggleChatReaction } from "./chat-reactions.drizzle.js"
import { loadChatMentions, loadChatMentionsFor } from "./chat-mentions.drizzle.js"
import { attachChatMedia, loadChatAttachments } from "./chat-attachments.drizzle.js"
import { isUuid } from "../db/cursor-helpers.js"
import type { PresignMedia } from "./media-presign.js"
import { mapSystemRow } from "./report-chat-repository.drizzle.js"
import { parseCityMention, effectiveJurisdictionHandle } from "./discussion-mentions.js"
import { assertReplyTarget, replyMapForRows } from "./chat-reply-hydration.js"

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
  ): Promise<ChatMessageDTO | null>
  reportHistory(
    reportId: string,
    before: string | undefined,
    limit: number,
    viewerUserId?: string | null,
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
  ): Promise<ChatMessageDTO | null>
  countReportMessages(reportId: string): Promise<number>
}

interface ChatRowSelect {
  id: string
  cleanup_id: string | null
  report_id: string | null
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
  return {
    id: r.id,
    cleanupId: r.cleanup_id ?? r.report_id!,
    ...(isReport ? { roomKind: "report" as const } : {}),
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
    cm.sender_id,
    cm.body,
    cm.kind,
    cm.attachments,
    cm.created_at,
    cm.edited_at,
    cm.deleted_at,
    cm.reply_to_id,
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
      ${tag(cte)}.sender_id,
      ${tag(cte)}.body,
      ${tag(cte)}.kind,
      ${tag(cte)}.attachments,
      ${tag(cte)}.created_at,
      ${tag(cte)}.edited_at,
      ${tag(cte)}.deleted_at,
      ${tag(cte)}.reply_to_id,
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
  type RoomScope = { column: "cleanup_id" | "report_id"; id: string }

  const anchorScope = (scope: RoomScope) =>
    scope.column === "report_id" ? sql`report_id = ${scope.id}` : sql`cleanup_id = ${scope.id}`
  const rowScope = (scope: RoomScope) =>
    scope.column === "report_id" ? sql`cm.report_id = ${scope.id}` : sql`cm.cleanup_id = ${scope.id}`

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

  async function historyScoped(
    scope: RoomScope,
    before: string | undefined,
    limit: number,
    viewerUserId: string | null,
  ): Promise<ChatHistoryPage> {
    let anchor: { createdAt: Date; id: string } | null = null
    if (before !== undefined && isUuid(before)) {
      const rows = await sql<{ created_at: Date; id: string }[]>`
        SELECT created_at, id FROM chat_messages
        WHERE id = ${before} AND ${anchorScope(scope)} AND deleted_at IS NULL
        LIMIT 1
      `
      if (rows[0]) anchor = { createdAt: rows[0].created_at, id: rows[0].id }
    }

    const cursorFilter =
      anchor !== null
        ? sql`AND (cm.created_at, cm.id) < (${anchor.createdAt}, ${anchor.id}::uuid)`
        : sql``

    const isReport = scope.column === "report_id"
    const [rows, reportCity] = await Promise.all([
      sql<ChatRowSelect[]>`
        SELECT ${chatColumns(sql, isReport)}
        FROM chat_messages cm
        LEFT JOIN users u ON u.id = cm.sender_id
        WHERE ${rowScope(scope)}
          AND cm.deleted_at IS NULL
          ${cursorFilter}
        ORDER BY cm.created_at DESC, cm.id DESC
        LIMIT ${limit + 1}
      `,
      resolveReportCity(scope),
    ])
    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const ids = page.map((r) => r.id)
    const [attachmentsByMessage, reactionsByMessage, mentionsByMessage, replyByTarget] =
      await Promise.all([
        presign ? loadChatAttachments(sql, ids, presign) : Promise.resolve(new Map<string, MediaDTO[]>()),
        loadChatReactionsFor(sql, ids, viewerUserId),
        loadChatMentionsFor(sql, ids),
        // Reply previews: ONE id=ANY(...) fetch over the SAME table for the page's distinct targets.
        replyMapForRows(sql, "chat_messages", page),
      ])
    const items = page.map((r) =>
      toMessageDTO(
        r,
        reactionsByMessage.get(r.id) ?? [],
        mentionsByMessage.get(r.id) ?? [],
        viewerUserId,
        undefined,
        attachmentsByMessage.get(r.id) ?? [],
        reportCity,
        r.reply_to_id !== null ? replyByTarget.get(r.reply_to_id) ?? null : null,
      ),
    )
    const last = page[page.length - 1]
    const nextCursor = hasMore && last ? last.id : null
    return { items, nextCursor }
  }

  async function findMessageScoped(
    scope: RoomScope,
    messageId: string,
    viewerUserId: string | null,
  ): Promise<ChatMessageDTO | null> {
    const isReport = scope.column === "report_id"
    const rows = await sql<ChatRowSelect[]>`
      SELECT ${chatColumns(sql, isReport)}
      FROM chat_messages cm
      LEFT JOIN users u ON u.id = cm.sender_id
      WHERE cm.id = ${messageId} AND ${rowScope(scope)} AND cm.deleted_at IS NULL
      LIMIT 1
    `
    const row = rows[0]
    if (!row) return null
    const [reactions, mentions, attachmentsByMessage, reportCity, replyByTarget] = await Promise.all([
      loadChatReactions(sql, row.id, viewerUserId),
      loadChatMentions(sql, row.id),
      presign ? loadChatAttachments(sql, [row.id], presign) : Promise.resolve(new Map<string, MediaDTO[]>()),
      resolveReportCity(scope),
      replyMapForRows(sql, "chat_messages", [row]),
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
    )
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

  async function softDeleteScoped(
    scope: RoomScope,
    messageId: string,
    senderId: string,
  ): Promise<ChatMessageDTO | null> {
    const isReport = scope.column === "report_id"
    const [rows, reportCity] = await Promise.all([
      sql<ChatRowSelect[]>`
        WITH updated AS (
          UPDATE chat_messages
          SET deleted_at = now()
          WHERE id = ${messageId}
            AND ${anchorScope(scope)}
            AND sender_id = ${senderId}
            AND deleted_at IS NULL
          RETURNING id, cleanup_id, report_id, sender_id, body, kind, attachments, created_at, edited_at, deleted_at, reply_to_id, system_status, system_kind, system_body
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
      const cleanupId = isReport ? null : input.cleanupId
      const reportId = isReport ? input.cleanupId : null
      // Reply validation (P2): the target must exist in THIS room and not be tombstoned — 422 with
      // fields.code reply_wrong_room / reply_deleted_target otherwise. Returns the hydrated preview so
      // the ack/broadcast DTO carries replyTo without a re-read. (Validate-then-insert races a
      // concurrent delete of the target; the reply then simply hydrates deleted:true on later reads.)
      const replyTo =
        input.replyToId !== undefined
          ? await assertReplyTarget(
              sql,
              "chat_messages",
              { column: isReport ? "report_id" : "cleanup_id", id: input.cleanupId },
              input.replyToId,
            )
          : null
      const run = async (q: Queryable) => q<ChatRowSelect[]>`
        WITH inserted AS (
          INSERT INTO chat_messages (id, cleanup_id, report_id, sender_id, body, kind, attachments, reply_to_id)
          VALUES (
            ${id},
            ${cleanupId},
            ${reportId},
            ${input.userId},
            ${input.body},
            ${kind},
            ${input.attachments != null ? sql.json(input.attachments as Parameters<typeof sql.json>[0]) : null},
            ${input.replyToId ?? null}
          )
          RETURNING id, cleanup_id, report_id, sender_id, body, kind, attachments, created_at, edited_at, deleted_at, reply_to_id, system_status, system_kind, system_body
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
          sender_id: string | null
          kind: ChatMessageKind
          created_at: Date
          deleted_at: Date | null
        }[]
      >`
        SELECT id, cleanup_id, report_id, sender_id, kind, created_at, deleted_at
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
    ): Promise<ChatHistoryPage> {
      return historyScoped({ column: "cleanup_id", id: cleanupId }, before, limit, viewerUserId)
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
    ): Promise<ChatMessageDTO | null> {
      return softDeleteScoped({ column: "cleanup_id", id: cleanupId }, messageId, senderId)
    },

    reportHistory(
      reportId: string,
      before: string | undefined,
      limit: number,
      viewerUserId: string | null = null,
    ): Promise<ChatHistoryPage> {
      return historyScoped({ column: "report_id", id: reportId }, before, limit, viewerUserId)
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
    ): Promise<ChatMessageDTO | null> {
      return softDeleteScoped({ column: "report_id", id: reportId }, messageId, senderId)
    },

    async countReportMessages(reportId: string): Promise<number> {
      const rows = await sql<{ count: number }[]>`
        SELECT COUNT(*)::int AS count FROM chat_messages
        WHERE report_id = ${reportId} AND deleted_at IS NULL
      `
      return rows[0]?.count ?? 0
    },
  }
}
