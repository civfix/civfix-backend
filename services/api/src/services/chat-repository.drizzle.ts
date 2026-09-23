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
import {
  loadChatReactions,
  loadChatReactionsFor,
  toggleChatReaction,
} from "./chat-reactions.drizzle.js"
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
import { liveMessageIds, toTombstoneDTO } from "./chat-tombstone.js"

export interface ReportCityContext {
  geoid: string
  name: string
  handle: string | null
}

export interface ChatMessageMeta {
  id: string
  cleanupId: string | null
  reportId: string | null
  groupId: string | null
  senderId: string | null
  kind: ChatMessageKind
  createdAt: Date
  deletedAt: Date | null
}

export interface InsertedChatRow {
  id: string
  createdAt: Date
}

export interface InsertMessageOptions {
  inTx?: (tx: Queryable, row: InsertedChatRow) => Promise<void>
}

export interface ChatRepository {
  insertMessage(
    input: PersistChatInput,
    id: string,
    options?: InsertMessageOptions,
  ): Promise<ChatMessageDTO>
  findMessageMeta(messageId: string): Promise<ChatMessageMeta | null>
  history(
    cleanupId: string,
    before: string | undefined,
    limit: number,
    viewerUserId?: string | null,
    around?: string,
  ): Promise<ChatHistoryPage>
  findMessage(
    cleanupId: string,
    messageId: string,
    viewerUserId: string | null,
  ): Promise<ChatMessageDTO | null>
  toggleReaction(messageId: string, userId: string, emoji: ReactionEmoji): Promise<boolean>
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
  setPinned(
    cleanupId: string,
    messageId: string,
    userId: string,
    pinned: boolean,
  ): Promise<ChatMessageDTO | null>
  setReportPinned(
    reportId: string,
    messageId: string,
    userId: string,
    pinned: boolean,
  ): Promise<ChatMessageDTO | null>
  listPins(cleanupId: string, viewerUserId: string | null): Promise<ChatMessageDTO[]>
  listReportPins(reportId: string, viewerUserId: string | null): Promise<ChatMessageDTO[]>
  reportHistory(
    reportId: string,
    before: string | undefined,
    limit: number,
    viewerUserId?: string | null,
    around?: string,
  ): Promise<ChatHistoryPage>
  findReportMessage(
    reportId: string,
    messageId: string,
    viewerUserId: string | null,
  ): Promise<ChatMessageDTO | null>
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
  groupHistory(
    groupId: string,
    before: string | undefined,
    limit: number,
    viewerUserId?: string | null,
    around?: string,
  ): Promise<ChatHistoryPage>
  findGroupMessage(
    groupId: string,
    messageId: string,
    viewerUserId: string | null,
  ): Promise<ChatMessageDTO | null>
  editGroupMessage(
    groupId: string,
    messageId: string,
    senderId: string,
    body: string,
  ): Promise<ChatMessageDTO | null>
  softDeleteGroup(
    groupId: string,
    messageId: string,
    senderId: string,
    opts?: SoftDeleteOpts,
  ): Promise<ChatMessageDTO | null>
  setGroupPinned(
    groupId: string,
    messageId: string,
    userId: string,
    pinned: boolean,
  ): Promise<ChatMessageDTO | null>
  listGroupPins(groupId: string, viewerUserId: string | null): Promise<ChatMessageDTO[]>
}

export interface SoftDeleteOpts {
  bypassSenderGate?: boolean
}

export { PIN_LIST_CAP }

interface ChatRowSelect {
  id: string
  cleanup_id: string | null
  report_id: string | null
  group_id: string | null
  sender_id: string | null
  body: string | null
  kind: ChatMessageKind
  attachments: unknown[] | null
  created_at: Date
  edited_at: Date | null
  deleted_at: Date | null
  reply_to_id: string | null
  pinned_at: Date | null
  system_status: string | null
  system_kind: string | null
  system_body: string | null
  sender_display_name: string | null
  sender_handle: string | null
  sender_bio: string | null
  sender_avatar_url: string | null
  sender_deleted_at: Date | null
  forwarded_to_city?: boolean
}

function toMessageDTO(
  r: ChatRowSelect,
  reactions: ReactionSummaryDTO[],
  mentions: UserMentionDTO[],
  viewerUserId?: string | null,
  clientId?: string,
  attachments: MediaDTO[] = [],
  reportCity?: ReportCityContext | null,
  replyTo?: ReplyToDTO | null,
  poll?: PollDTO | null,
): ChatMessageDTO {
  const dto = buildMessageDTO(
    r,
    reactions,
    mentions,
    viewerUserId,
    clientId,
    attachments,
    reportCity,
    replyTo,
    poll,
  )
  return r.deleted_at !== null ? toTombstoneDTO(dto, r.deleted_at) : dto
}

function buildMessageDTO(
  r: ChatRowSelect,
  reactions: ReactionSummaryDTO[],
  mentions: UserMentionDTO[],
  viewerUserId?: string | null,
  clientId?: string,
  attachments: MediaDTO[] = [],
  reportCity?: ReportCityContext | null,
  replyTo?: ReplyToDTO | null,
  poll?: PollDTO | null,
): ChatMessageDTO {
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
    ...(r.reply_to_id !== null ? { replyToId: r.reply_to_id, replyTo: replyTo ?? null } : {}),
    ...(r.pinned_at != null ? { pinnedAt: r.pinned_at.toISOString() } : {}),
    ...(poll != null ? { poll } : {}),
    mine: viewerUserId != null && r.sender_id === viewerUserId,
    ...(isReport ? cityForwardFields(r, reportCity) : {}),
    ...(clientId !== undefined ? { clientId } : {}),
  }
}

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
          handle,
          geoid: reportCity.geoid,
          name: reportCity.name,
          forwarded: forwardedToCity,
        }
      : null
  return { forwardedToCity, cityMention }
}

function forwardedColumn(sql: Queryable, alias: string) {
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

  const anchorScope = (scope: RoomScope) => sql`${sql(scope.column)} = ${scope.id}`

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

  async function hydrateRows(
    page: ChatRowSelect[],
    viewerUserId: string | null,
    reportCity: ReportCityContext | null,
  ): Promise<ChatMessageDTO[]> {
    const ids = liveMessageIds(page)
    const pollIds = page.filter((r) => r.kind === "poll" && r.deleted_at === null).map((r) => r.id)
    const [
      attachmentsByMessage,
      reactionsByMessage,
      mentionsByMessage,
      replyByTarget,
      pollsByMessage,
    ] = await Promise.all([
      presign
        ? loadChatAttachments(sql, ids, presign, viewerUserId)
        : Promise.resolve(new Map<string, MediaDTO[]>()),
      loadChatReactionsFor(sql, ids, viewerUserId),
      loadChatMentionsFor(sql, ids),
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
        r.reply_to_id !== null ? (replyByTarget.get(r.reply_to_id) ?? null) : null,
        pollsByMessage.get(r.id) ?? null,
      ),
    )
  }

  async function hydrateRow(
    scope: RoomScope,
    row: ChatRowSelect,
    viewerUserId: string | null,
  ): Promise<ChatMessageDTO> {
    const pollIds = row.kind === "poll" && row.deleted_at === null ? [row.id] : []
    const liveIds = liveMessageIds([row])
    const [reactions, mentions, attachmentsByMessage, reportCity, replyByTarget, pollsByMessage] =
      await Promise.all([
        liveIds.length > 0 ? loadChatReactions(sql, row.id, viewerUserId) : Promise.resolve([]),
        liveIds.length > 0 ? loadChatMentions(sql, row.id) : Promise.resolve([]),
        presign
          ? loadChatAttachments(sql, liveIds, presign, viewerUserId)
          : Promise.resolve(new Map<string, MediaDTO[]>()),
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
      row.reply_to_id !== null ? (replyByTarget.get(row.reply_to_id) ?? null) : null,
      pollsByMessage.get(row.id) ?? null,
    )
  }

  function roomSql(scope: RoomScope): RoomScopeSql<ChatRowSelect, ReportCityContext | null> {
    const isReport = scope.column === "report_id"
    return {
      table: "chat_messages",
      alias: "cm",
      scope: (prefix) =>
        prefix === null
          ? anchorScope(scope)
          : sql`${sql(prefix)}.${sql(scope.column)} = ${scope.id}`,
      columns: chatColumns(sql, isReport),
      from: sql`FROM chat_messages cm LEFT JOIN users u ON u.id = cm.sender_id`,
      context: () => resolveReportCity(scope),
      hydratePage: hydrateRows,
      hydrateOne: (row, viewerUserId) => hydrateRow(scope, row, viewerUserId),
    }
  }

  function historyScoped(
    scope: RoomScope,
    before: string | undefined,
    limit: number,
    viewerUserId: string | null,
    around?: string,
  ): Promise<ChatHistoryPage> {
    return roomHistory(sql, roomSql(scope), before, limit, viewerUserId, around)
  }

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

  function setPinnedScoped(
    scope: RoomScope,
    messageId: string,
    userId: string,
    pinned: boolean,
  ): Promise<ChatMessageDTO | null> {
    return roomSetPinned(sql, roomSql(scope), messageId, userId, pinned)
  }

  function listPinsScoped(
    scope: RoomScope,
    viewerUserId: string | null,
  ): Promise<ChatMessageDTO[]> {
    return roomListPins(sql, roomSql(scope), viewerUserId)
  }

  async function softDeleteScoped(
    scope: RoomScope,
    messageId: string,
    senderId: string,
    opts?: SoftDeleteOpts,
  ): Promise<ChatMessageDTO | null> {
    const isReport = scope.column === "report_id"
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
    const replyByTarget = await replyMapForRows(sql, "chat_messages", [row])
    return toMessageDTO(
      row,
      [],
      [],
      senderId,
      undefined,
      [],
      reportCity,
      row.reply_to_id !== null ? (replyByTarget.get(row.reply_to_id) ?? null) : null,
    )
  }

  return {
    async insertMessage(
      input: PersistChatInput,
      id: string,
      options: InsertMessageOptions = {},
    ): Promise<ChatMessageDTO> {
      const kind: ChatMessageKind = input.kind ?? "text"
      const uploadIds = input.mediaUploadIds ?? []
      const wantsMedia = !!presign && uploadIds.length > 0
      const isReport = input.roomKind === "report"
      const isGroup = input.roomKind === "group"
      const cleanupId = isReport || isGroup ? null : input.cleanupId
      const reportId = isReport ? input.cleanupId : null
      const groupId = isGroup ? input.cleanupId : null
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
      const inTx = options.inTx
      const [rows, reportCity] = await Promise.all([
        wantsMedia || inTx
          ? sql.begin(async (tx) => {
              const inserted = await run(tx)
              const createdAt = inserted[0]!.created_at
              if (wantsMedia) await attachChatMedia(tx, id, uploadIds, createdAt, input.userId)
              if (inTx) await inTx(tx, { id, createdAt })
              return inserted
            })
          : run(sql),
        isReport && input.cleanupId
          ? resolveReportCity({ column: "report_id", id: input.cleanupId })
          : Promise.resolve(null),
      ])
      const attachments = wantsMedia
        ? ((await loadChatAttachments(sql, [id], presign!, input.userId)).get(id) ?? [])
        : []
      return toMessageDTO(
        rows[0]!,
        [],
        [],
        input.userId,
        input.clientId,
        attachments,
        reportCity,
        replyTo,
      )
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
      return historyScoped(
        { column: "cleanup_id", id: cleanupId },
        before,
        limit,
        viewerUserId,
        around,
      )
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
      return historyScoped(
        { column: "report_id", id: reportId },
        before,
        limit,
        viewerUserId,
        around,
      )
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
