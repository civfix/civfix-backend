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
import type { ChatHistoryPage } from "@civfix/shared/interfaces"
import {
  loadChatReactions,
  loadChatReactionsFor,
  toggleChatReaction,
} from "./chat-reactions.drizzle.js"
import { loadChatMentions, loadChatMentionsFor } from "./chat-mentions-repository.drizzle.js"
import { attachChatMedia, loadChatAttachments } from "./chat-attachments.drizzle.js"
import { monotonicReadWatermark } from "./read-watermark-repository.drizzle.js"
import { assertReplyTarget, replyMapForRows } from "./chat-reply-hydration.js"
import { msKeysetFilter, type TimeCursor } from "../db/cursor-helpers.js"
import type { PresignMedia } from "./media-presign.js"
import {
  makeDrizzleRoomMessagesRepository,
  type RoomScopeSql,
} from "./room-messages-repository.drizzle.js"
import { liveMessageIds, toTombstoneDTO } from "./chat-tombstone.js"

// dm_messages is range-partitioned on created_at and an ack carries only the message id, so the bound
// lets the planner prune the lookup to recent partitions instead of probing every month ever created.
const DM_ACK_LOOKUP_WINDOW_DAYS = 90

export interface DmThread {
  id: string
  userLo: string
  userHi: string
  createdAt: Date
}

export interface DmThreadAggregate {
  threadId: string
  createdAt: Date
  peer: {
    id: string
    displayName: string
    handle: string | null
    bio: string | null
    avatarUrl: string | null
    deleted: boolean
  }
  last: {
    body: string | null
    createdAt: Date
    senderId: string
  } | null
  unread: number
}

export interface DmPersistInput {
  threadId: string
  senderId: string
  body: string
  kind?: ChatMessageKind
  clientId?: string
  attachments?: unknown[] | null
  mediaUploadIds?: string[]
  replyToId?: string
}

export interface DmMessageMeta {
  id: string
  threadId: string
  senderId: string
  kind: ChatMessageKind
  createdAt: Date
  deletedAt: Date | null
}

export interface DmRepository {
  openOrCreateThread(userA: string, userB: string): Promise<DmThread>
  getThreadForPair(userA: string, userB: string): Promise<DmThread | null>
  getThread(threadId: string): Promise<DmThread | null>
  isParticipant(threadId: string, userId: string): Promise<boolean>
  persist(input: DmPersistInput): Promise<ChatMessageDTO>
  editMessage(
    threadId: string,
    messageId: string,
    senderId: string,
    body: string,
  ): Promise<ChatMessageDTO | null>
  findMessageMeta(messageId: string): Promise<DmMessageMeta | null>
  softDelete(threadId: string, messageId: string, senderId: string): Promise<ChatMessageDTO | null>
  setPinned(
    threadId: string,
    messageId: string,
    userId: string,
    pinned: boolean,
  ): Promise<ChatMessageDTO | null>
  listPins(threadId: string, viewerUserId: string | null): Promise<ChatMessageDTO[]>
  history(
    threadId: string,
    before: string | undefined,
    limit: number,
    viewerUserId?: string | null,
    around?: string,
  ): Promise<ChatHistoryPage>
  findMessage(
    threadId: string,
    messageId: string,
    viewerUserId: string | null,
  ): Promise<ChatMessageDTO | null>
  toggleReaction(messageId: string, userId: string, emoji: ReactionEmoji): Promise<boolean>
  markRead(threadId: string, userId: string, at: Date): Promise<void>
  lastReadAt(threadId: string, userId: string): Promise<Date | null>
  countUnread(threadId: string, userId: string): Promise<number>
  resolveMessageCreatedAt(threadId: string, messageId: string): Promise<Date | null>
  listThreadsForUser(
    userId: string,
    limit?: number,
    cursor?: TimeCursor | null,
  ): Promise<DmThreadAggregate[]>
}

interface DmRowSelect {
  id: string
  thread_id: string
  sender_id: string
  body: string | null
  kind: ChatMessageKind
  attachments: unknown[] | null
  created_at: Date
  edited_at: Date | null
  deleted_at: Date | null
  reply_to_id: string | null
  pinned_at: Date | null
  sender_display_name: string
  sender_handle: string | null
  sender_bio: string | null
  sender_avatar_url: string | null
  sender_deleted_at: Date | null
}

interface MessageExtras {
  reactions?: ReactionSummaryDTO[]
  mentions?: UserMentionDTO[]
  viewerUserId?: string | null
  clientId?: string
  attachments?: MediaDTO[]
  replyTo?: ReplyToDTO | null
}

function toMessageDTO(r: DmRowSelect, extras: MessageExtras = {}): ChatMessageDTO {
  const dto = buildMessageDTO(r, extras)
  return r.deleted_at !== null ? toTombstoneDTO(dto, r.deleted_at) : dto
}

function buildMessageDTO(
  r: DmRowSelect,
  {
    reactions = [],
    mentions = [],
    viewerUserId,
    clientId,
    attachments = [],
    replyTo,
  }: MessageExtras,
): ChatMessageDTO {
  const author = publicAuthorIdentity({
    id: r.sender_id,
    displayName: r.sender_display_name,
    handle: r.sender_handle,
    avatarUrl: r.sender_avatar_url,
    deletedAt: r.sender_deleted_at,
  })
  return {
    id: r.id,
    cleanupId: r.thread_id,
    roomKind: "dm",
    from: {
      id: r.sender_id,
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
    mine: viewerUserId != null && r.sender_id === viewerUserId,
    ...(clientId !== undefined ? { clientId } : {}),
  }
}

function replyFor(
  row: Pick<DmRowSelect, "reply_to_id">,
  replyByTarget: Map<string, ReplyToDTO>,
): ReplyToDTO | null {
  return row.reply_to_id !== null ? (replyByTarget.get(row.reply_to_id) ?? null) : null
}

// dm_threads stores each pair once as (user_lo, user_hi), so both lookups and the insert order the ids.
function orderedPair(userA: string, userB: string): [string, string] {
  return userA < userB ? [userA, userB] : [userB, userA]
}

function selectDmRowFrom(tag: Queryable, cte: string) {
  return tag`
    SELECT
      ${tag(cte)}.id,
      ${tag(cte)}.thread_id,
      ${tag(cte)}.sender_id,
      ${tag(cte)}.body,
      ${tag(cte)}.kind,
      ${tag(cte)}.attachments,
      ${tag(cte)}.created_at,
      ${tag(cte)}.edited_at,
      ${tag(cte)}.deleted_at,
      ${tag(cte)}.reply_to_id,
      ${tag(cte)}.pinned_at,
      u.display_name AS sender_display_name,
      u.handle AS sender_handle,
      u.bio AS sender_bio,
      u.avatar_url AS sender_avatar_url,
      u.deleted_at AS sender_deleted_at
    FROM ${tag(cte)}
    JOIN users u ON u.id = ${tag(cte)}.sender_id
  `
}

export function makeDrizzleDmRepository(sql: Sql, presign?: PresignMedia): DmRepository {
  const dmColumns = sql`
    dm.id,
    dm.thread_id,
    dm.sender_id,
    dm.body,
    dm.kind,
    dm.attachments,
    dm.created_at,
    dm.edited_at,
    dm.deleted_at,
    dm.reply_to_id,
    dm.pinned_at,
    u.display_name AS sender_display_name,
    u.handle AS sender_handle,
    u.bio AS sender_bio,
    u.avatar_url AS sender_avatar_url,
    u.deleted_at AS sender_deleted_at
  `

  async function hydrateDmRows(
    page: DmRowSelect[],
    viewerUserId: string | null,
  ): Promise<ChatMessageDTO[]> {
    const ids = liveMessageIds(page)
    const [attachmentsByMessage, reactionsByMessage, mentionsByMessage, replyByTarget] =
      await Promise.all([
        presign
          ? loadChatAttachments(sql, ids, presign, viewerUserId)
          : Promise.resolve(new Map<string, MediaDTO[]>()),
        loadChatReactionsFor(sql, ids, viewerUserId),
        loadChatMentionsFor(sql, ids),
        replyMapForRows(sql, "dm_messages", page),
      ])
    return page.map((r) =>
      toMessageDTO(r, {
        reactions: reactionsByMessage.get(r.id) ?? [],
        mentions: mentionsByMessage.get(r.id) ?? [],
        viewerUserId,
        attachments: attachmentsByMessage.get(r.id) ?? [],
        replyTo: replyFor(r, replyByTarget),
      }),
    )
  }

  async function hydrateDmRow(
    row: DmRowSelect,
    viewerUserId: string | null,
  ): Promise<ChatMessageDTO> {
    const liveIds = liveMessageIds([row])
    const [reactions, mentions, attachmentsByMessage, replyByTarget] = await Promise.all([
      liveIds.length > 0 ? loadChatReactions(sql, row.id, viewerUserId) : Promise.resolve([]),
      liveIds.length > 0 ? loadChatMentions(sql, row.id) : Promise.resolve([]),
      presign
        ? loadChatAttachments(sql, liveIds, presign, viewerUserId)
        : Promise.resolve(new Map<string, MediaDTO[]>()),
      replyMapForRows(sql, "dm_messages", [row]),
    ])
    return toMessageDTO(row, {
      reactions,
      mentions,
      viewerUserId,
      attachments: attachmentsByMessage.get(row.id) ?? [],
      replyTo: replyFor(row, replyByTarget),
    })
  }

  function roomSql(threadId: string): RoomScopeSql<DmRowSelect, null> {
    return {
      table: "dm_messages",
      alias: "dm",
      scope: (prefix) =>
        prefix === null
          ? sql`thread_id = ${threadId}`
          : sql`${sql(prefix)}.thread_id = ${threadId}`,
      columns: dmColumns,
      from: sql`FROM dm_messages dm JOIN users u ON u.id = dm.sender_id`,
      context: () => Promise.resolve(null),
      hydratePage: (rows, viewerUserId) => hydrateDmRows(rows, viewerUserId),
      hydrateOne: hydrateDmRow,
    }
  }

  return {
    async openOrCreateThread(userA: string, userB: string): Promise<DmThread> {
      const [lo, hi] = orderedPair(userA, userB)

      const inserted = await sql<{ id: string; created_at: Date }[]>`
        INSERT INTO dm_threads (user_lo, user_hi)
        VALUES (${lo}, ${hi})
        ON CONFLICT (user_lo, user_hi) DO NOTHING
        RETURNING id, created_at
      `
      if (inserted[0]) {
        return { id: inserted[0].id, userLo: lo, userHi: hi, createdAt: inserted[0].created_at }
      }
      const existing = await sql<{ id: string; created_at: Date }[]>`
        SELECT id, created_at FROM dm_threads WHERE user_lo = ${lo} AND user_hi = ${hi} LIMIT 1
      `
      const row = existing[0]!
      return { id: row.id, userLo: lo, userHi: hi, createdAt: row.created_at }
    },

    async getThreadForPair(userA: string, userB: string): Promise<DmThread | null> {
      const [lo, hi] = orderedPair(userA, userB)
      const rows = await sql<{ id: string; created_at: Date }[]>`
        SELECT id, created_at FROM dm_threads WHERE user_lo = ${lo} AND user_hi = ${hi} LIMIT 1
      `
      const r = rows[0]
      return r ? { id: r.id, userLo: lo, userHi: hi, createdAt: r.created_at } : null
    },

    async getThread(threadId: string): Promise<DmThread | null> {
      const rows = await sql<{ id: string; user_lo: string; user_hi: string; created_at: Date }[]>`
        SELECT id, user_lo, user_hi, created_at FROM dm_threads WHERE id = ${threadId} LIMIT 1
      `
      const r = rows[0]
      return r ? { id: r.id, userLo: r.user_lo, userHi: r.user_hi, createdAt: r.created_at } : null
    },

    async isParticipant(threadId: string, userId: string): Promise<boolean> {
      const rows = await sql<{ one: number }[]>`
        SELECT 1 AS one FROM dm_threads
        WHERE id = ${threadId} AND (user_lo = ${userId} OR user_hi = ${userId})
        LIMIT 1
      `
      return rows.length > 0
    },

    async persist(input: DmPersistInput): Promise<ChatMessageDTO> {
      const kind: ChatMessageKind = input.kind ?? "text"
      const uploadIds = input.mediaUploadIds ?? []
      const wantsMedia = !!presign && uploadIds.length > 0
      const replyTo =
        input.replyToId !== undefined
          ? await assertReplyTarget(
              sql,
              "dm_messages",
              { column: "thread_id", id: input.threadId },
              input.replyToId,
            )
          : null
      const run = async (q: Queryable) => q<DmRowSelect[]>`
        WITH inserted AS (
          INSERT INTO dm_messages (thread_id, sender_id, body, kind, attachments, reply_to_id)
          VALUES (
            ${input.threadId},
            ${input.senderId},
            ${input.body},
            ${kind},
            ${input.attachments != null ? sql.json(input.attachments as Parameters<typeof sql.json>[0]) : null},
            ${input.replyToId ?? null}
          )
          RETURNING id, thread_id, sender_id, body, kind, attachments, created_at, edited_at, deleted_at, reply_to_id, pinned_at
        )
        ${selectDmRowFrom(q, "inserted")}
      `
      const rows = wantsMedia
        ? await sql.begin(async (tx) => {
            const inserted = await run(tx)
            await attachChatMedia(
              tx,
              inserted[0]!.id,
              uploadIds,
              inserted[0]!.created_at,
              input.senderId,
            )
            return inserted
          })
        : await run(sql)
      const messageId = rows[0]!.id
      const attachments = wantsMedia
        ? ((await loadChatAttachments(sql, [messageId], presign!, input.senderId)).get(messageId) ??
          [])
        : []
      return toMessageDTO(rows[0]!, {
        viewerUserId: input.senderId,
        clientId: input.clientId,
        attachments,
        replyTo,
      })
    },

    async editMessage(
      threadId: string,
      messageId: string,
      senderId: string,
      body: string,
    ): Promise<ChatMessageDTO | null> {
      const rows = await sql<DmRowSelect[]>`
        WITH updated AS (
          UPDATE dm_messages
          SET body = ${body}, edited_at = now()
          WHERE id = ${messageId}
            AND thread_id = ${threadId}
            AND sender_id = ${senderId}
            AND deleted_at IS NULL
          RETURNING id, thread_id, sender_id, body, kind, attachments, created_at, edited_at, deleted_at, reply_to_id, pinned_at
        )
        ${selectDmRowFrom(sql, "updated")}
      `
      const row = rows[0]
      if (!row) return null
      return hydrateDmRow(row, senderId)
    },

    async findMessageMeta(messageId: string): Promise<DmMessageMeta | null> {
      const rows = await sql<
        {
          id: string
          thread_id: string
          sender_id: string
          kind: ChatMessageKind
          created_at: Date
          deleted_at: Date | null
        }[]
      >`
        SELECT id, thread_id, sender_id, kind, created_at, deleted_at
        FROM dm_messages
        WHERE id = ${messageId}
        LIMIT 1
      `
      const r = rows[0]
      if (!r) return null
      return {
        id: r.id,
        threadId: r.thread_id,
        senderId: r.sender_id,
        kind: r.kind,
        createdAt: r.created_at,
        deletedAt: r.deleted_at,
      }
    },

    async softDelete(
      threadId: string,
      messageId: string,
      senderId: string,
    ): Promise<ChatMessageDTO | null> {
      const rows = await sql<DmRowSelect[]>`
        WITH updated AS (
          UPDATE dm_messages
          SET deleted_at = now()
          WHERE id = ${messageId}
            AND thread_id = ${threadId}
            AND sender_id = ${senderId}
            AND deleted_at IS NULL
          RETURNING id, thread_id, sender_id, body, kind, attachments, created_at, edited_at, deleted_at, reply_to_id, pinned_at
        )
        ${selectDmRowFrom(sql, "updated")}
      `
      const row = rows[0]
      if (!row) return null
      const replyByTarget = await replyMapForRows(sql, "dm_messages", [row])
      return toMessageDTO(row, { viewerUserId: senderId, replyTo: replyFor(row, replyByTarget) })
    },

    history(
      threadId: string,
      before: string | undefined,
      limit: number,
      viewerUserId: string | null = null,
      around?: string,
    ): Promise<ChatHistoryPage> {
      return makeDrizzleRoomMessagesRepository(sql, roomSql(threadId)).history(
        before,
        limit,
        viewerUserId,
        around,
      )
    },

    findMessage(
      threadId: string,
      messageId: string,
      viewerUserId: string | null,
    ): Promise<ChatMessageDTO | null> {
      return makeDrizzleRoomMessagesRepository(sql, roomSql(threadId)).findMessage(
        messageId,
        viewerUserId,
      )
    },

    toggleReaction(messageId: string, userId: string, emoji: ReactionEmoji): Promise<boolean> {
      return toggleChatReaction(sql, messageId, userId, emoji)
    },

    async markRead(threadId: string, userId: string, at: Date): Promise<void> {
      await monotonicReadWatermark(
        sql,
        "dm_read_state",
        { thread_id: threadId, user_id: userId },
        at,
      )
    },

    async lastReadAt(threadId: string, userId: string): Promise<Date | null> {
      const rows = await sql<{ last_read_at: Date | null }[]>`
        SELECT last_read_at FROM dm_read_state
        WHERE thread_id = ${threadId} AND user_id = ${userId}
      `
      return rows[0]?.last_read_at ?? null
    },

    async countUnread(threadId: string, userId: string): Promise<number> {
      const rows = await sql<{ unread: number }[]>`
        SELECT count(*)::int AS unread
        FROM dm_messages m
        JOIN dm_threads t ON t.id = m.thread_id
        LEFT JOIN dm_read_state rs ON rs.thread_id = t.id AND rs.user_id = ${userId}
        WHERE m.thread_id = ${threadId}
          AND m.deleted_at IS NULL
          AND m.sender_id <> ${userId}
          AND m.created_at > GREATEST(t.created_at, COALESCE(rs.last_read_at, to_timestamp(0)))
      `
      return Number(rows[0]?.unread ?? 0)
    },

    async resolveMessageCreatedAt(threadId: string, messageId: string): Promise<Date | null> {
      const rows = await sql<{ created_at: Date }[]>`
        SELECT created_at FROM dm_messages
        WHERE id = ${messageId} AND thread_id = ${threadId}
          AND created_at >= now() - make_interval(days => ${DM_ACK_LOOKUP_WINDOW_DAYS})
        LIMIT 1
      `
      return rows[0]?.created_at ?? null
    },

    async listThreadsForUser(
      userId: string,
      limit?: number,
      cursor?: TimeCursor | null,
    ): Promise<DmThreadAggregate[]> {
      const limitClause = limit !== undefined ? sql`LIMIT ${limit}` : sql``
      const rawActivity = sql`COALESCE(last_msg.created_at, t.created_at)`
      const activity = sql`date_trunc('milliseconds', ${rawActivity})`
      const cursorFilter = msKeysetFilter(sql, activity, sql`t.id`, cursor)
      const rows = await sql<
        {
          thread_id: string
          thread_created_at: Date
          peer_id: string
          peer_display_name: string
          peer_handle: string | null
          peer_bio: string | null
          peer_avatar_url: string | null
          peer_deleted_at: Date | null
          last_body: string | null
          last_created_at: Date | null
          last_sender_id: string | null
          unread: number
        }[]
      >`
        SELECT
          t.id AS thread_id,
          t.created_at AS thread_created_at,
          peer.id AS peer_id,
          peer.display_name AS peer_display_name,
          peer.handle AS peer_handle,
          peer.bio AS peer_bio,
          peer.avatar_url AS peer_avatar_url,
          peer.deleted_at AS peer_deleted_at,
          last_msg.body AS last_body,
          last_msg.created_at AS last_created_at,
          last_msg.sender_id AS last_sender_id,
          (
            SELECT count(*)::int
            FROM dm_messages um
            WHERE um.thread_id = t.id
              AND um.deleted_at IS NULL
              AND um.sender_id = peer.id
              AND um.created_at > GREATEST(t.created_at, COALESCE(rs.last_read_at, to_timestamp(0)))
          ) AS unread
        FROM dm_threads t
        JOIN users peer
          ON peer.id = CASE WHEN t.user_lo = ${userId} THEN t.user_hi ELSE t.user_lo END
        LEFT JOIN dm_read_state rs ON rs.thread_id = t.id AND rs.user_id = ${userId}
        LEFT JOIN LATERAL (
          SELECT dm.body, dm.created_at, dm.sender_id
          FROM dm_messages dm
          WHERE dm.thread_id = t.id AND dm.deleted_at IS NULL
          ORDER BY dm.created_at DESC, dm.id DESC
          LIMIT 1
        ) last_msg ON TRUE
        LEFT JOIN conversation_hides h
          ON h.user_id = ${userId} AND h.room_kind = 'dm' AND h.room_id = t.id
        WHERE (t.user_lo = ${userId} OR t.user_hi = ${userId})
          AND (h.hidden_at IS NULL OR ${rawActivity} > h.hidden_at)
          AND NOT EXISTS (
            SELECT 1 FROM user_blocks b
            WHERE (b.blocker_id = ${userId} AND b.blocked_id = peer.id)
               OR (b.blocker_id = peer.id AND b.blocked_id = ${userId})
          )
          ${cursorFilter}
        ORDER BY ${activity} DESC, t.id DESC
        ${limitClause}
      `
      return rows.map((r) => {
        const identity = publicAuthorIdentity({
          id: r.peer_id,
          displayName: r.peer_display_name,
          handle: r.peer_handle,
          avatarUrl: r.peer_avatar_url,
          deletedAt: r.peer_deleted_at,
        })
        return {
          threadId: r.thread_id,
          createdAt: r.thread_created_at,
          peer: {
            id: r.peer_id,
            displayName: identity.name,
            handle: identity.handle,
            bio: identity.deleted ? null : r.peer_bio,
            avatarUrl: identity.avatarUrl ?? null,
            deleted: identity.deleted,
          },
          last:
            r.last_created_at !== null
              ? { body: r.last_body, createdAt: r.last_created_at, senderId: r.last_sender_id! }
              : null,
          unread: Number(r.unread),
        }
      })
    },

    setPinned(
      threadId: string,
      messageId: string,
      userId: string,
      pinned: boolean,
    ): Promise<ChatMessageDTO | null> {
      return makeDrizzleRoomMessagesRepository(sql, roomSql(threadId)).setPinned(
        messageId,
        userId,
        pinned,
      )
    },

    listPins(threadId: string, viewerUserId: string | null): Promise<ChatMessageDTO[]> {
      return makeDrizzleRoomMessagesRepository(sql, roomSql(threadId)).listPins(viewerUserId)
    },
  }
}
