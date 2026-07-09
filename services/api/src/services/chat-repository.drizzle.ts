
import type { Queryable, Sql } from "../db/client.js"
import { publicAuthorIdentity } from "./public-author.js"
import type {
  ChatMessageDTO,
  ChatMessageKind,
  MediaDTO,
  ReactionEmoji,
  ReactionSummaryDTO,
  UserMentionDTO,
} from "@civfix/shared"
import type { ChatHistoryPage, PersistChatInput } from "@civfix/shared/interfaces"
import { loadChatReactions, loadChatReactionsFor, toggleChatReaction } from "./chat-reactions.drizzle.js"
import { loadChatMentions, loadChatMentionsFor } from "./chat-mentions.drizzle.js"
import { attachChatMedia, loadChatAttachments } from "./chat-attachments.drizzle.js"
import { isUuid } from "../db/cursor-helpers.js"
import type { PresignMedia } from "./media-presign.js"
import { mapSystemRow } from "./report-chat-repository.drizzle.js"

export interface ChatRepository {
  insertMessage(input: PersistChatInput, id: string): Promise<ChatMessageDTO>
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
  // System-message payload; NULL on every non-system row. Only ever populated for report system rows.
  system_status: string | null
  system_kind: string | null
  system_body: string | null
  sender_display_name: string | null
  sender_handle: string | null
  sender_bio: string | null
  sender_avatar_url: string | null
  sender_deleted_at: Date | null
}

function toMessageDTO(
  r: ChatRowSelect,
  reactions: ReactionSummaryDTO[],
  mentions: UserMentionDTO[],
  viewerUserId?: string | null,
  clientId?: string,
  attachments: MediaDTO[] = [],
): ChatMessageDTO {
  // A report SYSTEM message has no author (sender_id NULL); delegate to the pure system mapper so its
  // from:null / kind:"system" / structured system payload render in history + broadcasts. Only report
  // rows can reach this branch (cleanup/dm rows always carry a sender), so cleanup/dm mapping is
  // unchanged. system_status is guaranteed non-null on a real system row.
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
  return {
    id: r.id,
    cleanupId: r.cleanup_id ?? r.report_id!,
    ...(r.report_id !== null ? { roomKind: "report" as const } : {}),
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
    mine: viewerUserId != null && r.sender_id === viewerUserId,
    ...(clientId !== undefined ? { clientId } : {}),
  }
}

function chatColumns(sql: Queryable) {
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
    cm.system_status,
    cm.system_kind,
    cm.system_body,
    u.display_name AS sender_display_name,
    u.handle AS sender_handle,
    u.bio AS sender_bio,
    u.avatar_url AS sender_avatar_url,
    u.deleted_at AS sender_deleted_at
  `
}

function selectChatRowFrom(tag: Queryable, cte: string) {
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
      ${tag(cte)}.system_status,
      ${tag(cte)}.system_kind,
      ${tag(cte)}.system_body,
      u.display_name AS sender_display_name,
      u.handle AS sender_handle,
      u.bio AS sender_bio,
      u.avatar_url AS sender_avatar_url,
      u.deleted_at AS sender_deleted_at
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

    const rows = await sql<ChatRowSelect[]>`
      SELECT ${chatColumns(sql)}
      FROM chat_messages cm
      LEFT JOIN users u ON u.id = cm.sender_id
      WHERE ${rowScope(scope)}
        AND cm.deleted_at IS NULL
        ${cursorFilter}
      ORDER BY cm.created_at DESC, cm.id DESC
      LIMIT ${limit + 1}
    `
    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const ids = page.map((r) => r.id)
    const [attachmentsByMessage, reactionsByMessage, mentionsByMessage] = await Promise.all([
      presign ? loadChatAttachments(sql, ids, presign) : Promise.resolve(new Map<string, MediaDTO[]>()),
      loadChatReactionsFor(sql, ids, viewerUserId),
      loadChatMentionsFor(sql, ids),
    ])
    const items = page.map((r) =>
      toMessageDTO(
        r,
        reactionsByMessage.get(r.id) ?? [],
        mentionsByMessage.get(r.id) ?? [],
        viewerUserId,
        undefined,
        attachmentsByMessage.get(r.id) ?? [],
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
    const rows = await sql<ChatRowSelect[]>`
      SELECT ${chatColumns(sql)}
      FROM chat_messages cm
      LEFT JOIN users u ON u.id = cm.sender_id
      WHERE cm.id = ${messageId} AND ${rowScope(scope)} AND cm.deleted_at IS NULL
      LIMIT 1
    `
    const row = rows[0]
    if (!row) return null
    const [reactions, mentions, attachmentsByMessage] = await Promise.all([
      loadChatReactions(sql, row.id, viewerUserId),
      loadChatMentions(sql, row.id),
      presign ? loadChatAttachments(sql, [row.id], presign) : Promise.resolve(new Map<string, MediaDTO[]>()),
    ])
    return toMessageDTO(row, reactions, mentions, viewerUserId, undefined, attachmentsByMessage.get(row.id) ?? [])
  }

  async function softDeleteScoped(
    scope: RoomScope,
    messageId: string,
    senderId: string,
  ): Promise<ChatMessageDTO | null> {
    const rows = await sql<ChatRowSelect[]>`
      WITH updated AS (
        UPDATE chat_messages
        SET deleted_at = now()
        WHERE id = ${messageId}
          AND ${anchorScope(scope)}
          AND sender_id = ${senderId}
          AND deleted_at IS NULL
        RETURNING id, cleanup_id, report_id, sender_id, body, kind, attachments, created_at, edited_at, deleted_at, system_status, system_kind, system_body
      )
      ${selectChatRowFrom(sql, "updated")}
    `
    const row = rows[0]
    if (!row) return null
    return toMessageDTO(row, [], [], senderId)
  }

  return {
    async insertMessage(input: PersistChatInput, id: string): Promise<ChatMessageDTO> {
      const kind: ChatMessageKind = input.kind ?? "text"
      const uploadIds = input.mediaUploadIds ?? []
      const wantsMedia = !!presign && uploadIds.length > 0
      const isReport = input.roomKind === "report"
      const cleanupId = isReport ? null : input.cleanupId
      const reportId = isReport ? input.cleanupId : null
      const run = async (q: Queryable) => q<ChatRowSelect[]>`
        WITH inserted AS (
          INSERT INTO chat_messages (id, cleanup_id, report_id, sender_id, body, kind, attachments)
          VALUES (
            ${id},
            ${cleanupId},
            ${reportId},
            ${input.userId},
            ${input.body},
            ${kind},
            ${input.attachments != null ? sql.json(input.attachments as Parameters<typeof sql.json>[0]) : null}
          )
          RETURNING id, cleanup_id, report_id, sender_id, body, kind, attachments, created_at, edited_at, deleted_at, system_status, system_kind, system_body
        )
        ${selectChatRowFrom(q, "inserted")}
      `
      const rows = wantsMedia
        ? await sql.begin(async (tx) => {
            const inserted = await run(tx)
            await attachChatMedia(tx, id, uploadIds)
            return inserted
          })
        : await run(sql)
      const attachments = wantsMedia ? (await loadChatAttachments(sql, [id], presign!)).get(id) ?? [] : []
      return toMessageDTO(rows[0]!, [], [], input.userId, input.clientId, attachments)
    },

    history(
      cleanupId: string,
      before: string | undefined,
      limit: number,
      viewerUserId: string | null = null,
    ): Promise<ChatHistoryPage> {
      return historyScoped({ column: "cleanup_id", id: cleanupId }, before, limit, viewerUserId)
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
