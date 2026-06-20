/**
 * Postgres-backed DmRepository: the persistence seam for 1:1 direct messages.
 *
 * Separate from the cleanup chat stack (chat_messages / cleanup_members) so cleanup group chat stays
 * byte-for-byte unchanged. dm_messages mirrors chat_messages exactly (declaratively partitioned by
 * RANGE(created_at), PK(id, created_at) — see 0009_dm_and_privacy.sql), so the persist/history code here
 * mirrors chat-repository.drizzle.ts: the read joins the sender's user row to build ChatMessageDTO.from,
 * and history pages newest-first over (created_at, id) with a room-scoped cursor anchor.
 *
 * The ChatMessageDTO this returns carries cleanupId = the dm thread id and roomKind:"dm" (the wire
 * contract keeps the field name `cleanupId` for both kinds — both are bare UUIDs and clients route by
 * (roomKind, cleanupId)).
 *
 * THREADS (idempotent open): a dm thread is unique per UNORDERED user pair, stored as (user_lo, user_hi)
 * with user_lo < user_hi. openOrCreateThread orders the pair, INSERT ... ON CONFLICT DO NOTHING, and
 * SELECTs the existing row when the insert was a no-op — so it converges on one thread regardless of who
 * initiates or how many times it is called.
 */

import type { Sql } from "../db/client.js"
import { publicAuthorIdentity } from "./public-author.js"
import type {
  ChatMessageDTO,
  ChatMessageKind,
  ReactionEmoji,
  ReactionSummaryDTO,
  UserMentionDTO,
} from "@civfix/shared"
import type { ChatHistoryPage } from "@civfix/shared/interfaces"
import { loadChatReactions, toggleChatReaction } from "./chat-reactions.drizzle.js"
import { loadChatMentions } from "./chat-mentions.drizzle.js"

/** A dm thread row (the participant pair ordered lo < hi). */
export interface DmThread {
  id: string
  userLo: string
  userHi: string
  createdAt: Date
}

/** A per-thread aggregate row for the threads UNION: peer + last message + unread. */
export interface DmThreadAggregate {
  threadId: string
  createdAt: Date
  /** The OTHER participant (the viewer is never the peer). */
  peer: {
    id: string
    displayName: string
    handle: string | null
    bio: string | null
    avatarUrl: string | null
  }
  /** The most-recent (non-deleted) message, or null when the thread has no messages yet. */
  last: {
    body: string | null
    createdAt: Date
    senderId: string
  } | null
  /** Count of messages from the peer after max(thread.created_at, last_read_at). */
  unread: number
}

/** Insert input for a dm message (mirrors PersistChatInput, but addressed by threadId). */
export interface DmPersistInput {
  threadId: string
  senderId: string
  body: string
  kind?: ChatMessageKind
  clientId?: string
  attachments?: unknown[] | null
}

/**
 * Persistence + membership + read-state seam for direct messages. The production impl runs Drizzle/pg;
 * the offline dev/test path passes an in-memory implementation (see di.ts / test helpers).
 */
export interface DmRepository {
  /** Open (or fetch) the thread for an unordered user pair. Idempotent. */
  openOrCreateThread(userA: string, userB: string): Promise<DmThread>
  /** Find (WITHOUT creating) the thread for an unordered user pair (null when none exists). */
  getThreadForPair(userA: string, userB: string): Promise<DmThread | null>
  /** Load a thread by id (null when missing). */
  getThread(threadId: string): Promise<DmThread | null>
  /** Whether `userId` is one of the thread's two participants. */
  isParticipant(threadId: string, userId: string): Promise<boolean>
  /** Insert a dm message and return it as a ChatMessageDTO (roomKind:"dm", cleanupId=threadId). */
  persist(input: DmPersistInput): Promise<ChatMessageDTO>
  /**
   * Edit a dm message's body and stamp edited_at = now(), returning the updated ChatMessageDTO. SENDER-ONLY
   * + thread-scoped + not-soft-deleted: the UPDATE's WHERE gates on (id, thread_id, sender_id, deleted_at IS
   * NULL), so it is a no-op (returns null) when the message is missing, belongs to another thread, was not
   * sent by `senderId`, or is soft-deleted. A null return therefore means not-found OR forbidden — the
   * caller maps it to a 404/403 without distinguishing them.
   */
  editMessage(
    threadId: string,
    messageId: string,
    senderId: string,
    body: string,
  ): Promise<ChatMessageDTO | null>
  /**
   * Soft-delete (tombstone) a dm message by its author. SENDER-ONLY + thread-scoped + not-already-deleted
   * (same WHERE gate as editMessage). Returns the tombstoned ChatMessageDTO, or null when the message is
   * missing / belongs to another thread / was not sent by `senderId` / already deleted.
   */
  softDelete(
    threadId: string,
    messageId: string,
    senderId: string,
  ): Promise<ChatMessageDTO | null>
  /** Page a thread's messages newest-first, before the given message id (cursor). roomKind:"dm".
   *  `viewerUserId` (optional) resolves each message's reaction `mine` flag for the loader. */
  history(
    threadId: string,
    before: string | undefined,
    limit: number,
    viewerUserId?: string | null,
  ): Promise<ChatHistoryPage>
  /**
   * Load ONE dm message (scoped to its thread) as a ChatMessageDTO for the viewer, with reactions aggregated
   * (+ the viewer's `mine` flag). Null when the message does not exist in that thread or is soft-deleted.
   * Used by the reaction toggle to validate the target + return the recomputed message.
   */
  findMessage(
    threadId: string,
    messageId: string,
    viewerUserId: string | null,
  ): Promise<ChatMessageDTO | null>
  /**
   * Toggle one of a user's emoji reactions on a dm message (insert-or-delete by composite PK). Returns true
   * when the reaction is now PRESENT (added), false when removed. Mirrors discussion repo.toggleReaction.
   */
  toggleReaction(messageId: string, userId: string, emoji: ReactionEmoji): Promise<boolean>
  /** Record that `userId` read `threadId` up to `at`. Monotonic (never moves the watermark back). */
  markRead(threadId: string, userId: string, at: Date): Promise<void>
  /** The last-read timestamp for (thread, user), or null when never recorded. */
  lastReadAt(threadId: string, userId: string): Promise<Date | null>
  /** Resolve a message's created_at (scoped to the thread), for the ack watermark. Null when unknown. */
  resolveMessageCreatedAt(threadId: string, messageId: string): Promise<Date | null>
  /**
   * The viewer's dm threads (excluding any where either party blocked the other), each with the peer,
   * the last message, and the unread count. Drives the threads UNION.
   */
  listThreadsForUser(userId: string): Promise<DmThreadAggregate[]>
}

/** A dm message row joined with its sender's person fields, as selected for the DTO. */
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
  sender_display_name: string
  sender_handle: string | null
  sender_bio: string | null
  sender_deleted_at: Date | null
}

/**
 * Project a selected dm row into the wire ChatMessageDTO (roomKind:"dm", cleanupId=thread_id). `reactions`
 * is the aggregated per-emoji summary, `mentions` the resolved USER @-mentions (both empty for a freshly-
 * inserted message; the gateway projects a new send's resolved mentions, history hydrates via loadChatMentions).
 */
function toMessageDTO(
  r: DmRowSelect,
  reactions: ReactionSummaryDTO[],
  mentions: UserMentionDTO[],
  viewerUserId?: string | null,
  clientId?: string,
): ChatMessageDTO {
  // PUBLIC author identity: a deleted (tombstoned) sender renders "Deleted User" (no handle/avatar, deleted:true).
  const author = publicAuthorIdentity({
    id: r.sender_id,
    displayName: r.sender_display_name,
    handle: r.sender_handle,
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
    ...(r.attachments !== null ? { attachments: r.attachments } : {}),
    reactions,
    mentions,
    createdAt: r.created_at.toISOString(),
    ...(r.edited_at !== null ? { editedAt: r.edited_at.toISOString() } : {}),
    ...(r.deleted_at !== null ? { deletedAt: r.deleted_at.toISOString() } : {}),
    mine: viewerUserId != null && r.sender_id === viewerUserId,
    ...(clientId !== undefined ? { clientId } : {}),
  }
}

export function makeDrizzleDmRepository(sql: Sql): DmRepository {
  return {
    async openOrCreateThread(userA: string, userB: string): Promise<DmThread> {
      // Order the pair so the unique (user_lo, user_hi) key is stable regardless of who initiates.
      const lo = userA < userB ? userA : userB
      const hi = userA < userB ? userB : userA

      const inserted = await sql<{ id: string; created_at: Date }[]>`
        INSERT INTO dm_threads (user_lo, user_hi)
        VALUES (${lo}, ${hi})
        ON CONFLICT (user_lo, user_hi) DO NOTHING
        RETURNING id, created_at
      `
      if (inserted[0]) {
        return { id: inserted[0].id, userLo: lo, userHi: hi, createdAt: inserted[0].created_at }
      }
      // The insert was a no-op (thread already exists): select the existing row.
      const existing = await sql<{ id: string; created_at: Date }[]>`
        SELECT id, created_at FROM dm_threads WHERE user_lo = ${lo} AND user_hi = ${hi} LIMIT 1
      `
      const row = existing[0]!
      return { id: row.id, userLo: lo, userHi: hi, createdAt: row.created_at }
    },

    async getThreadForPair(userA: string, userB: string): Promise<DmThread | null> {
      const lo = userA < userB ? userA : userB
      const hi = userA < userB ? userB : userA
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
      // Insert, then read back joined with the sender so `from` is populated. created_at defaults to now()
      // in the DB; we read it back rather than guessing so the DTO matches the persisted row exactly.
      const rows = await sql<DmRowSelect[]>`
        WITH inserted AS (
          INSERT INTO dm_messages (thread_id, sender_id, body, kind, attachments)
          VALUES (
            ${input.threadId},
            ${input.senderId},
            ${input.body},
            ${kind},
            ${input.attachments != null ? sql.json(input.attachments as Parameters<typeof sql.json>[0]) : null}
          )
          RETURNING id, thread_id, sender_id, body, kind, attachments, created_at, edited_at, deleted_at
        )
        SELECT
          inserted.id,
          inserted.thread_id,
          inserted.sender_id,
          inserted.body,
          inserted.kind,
          inserted.attachments,
          inserted.created_at,
          inserted.edited_at,
          inserted.deleted_at,
          u.display_name AS sender_display_name,
          u.handle AS sender_handle,
          u.bio AS sender_bio,
          u.deleted_at AS sender_deleted_at
        FROM inserted
        JOIN users u ON u.id = inserted.sender_id
      `
      // A freshly-inserted message has no reactions/mentions persisted yet (the gateway projects a send's
      // resolved mentions onto its broadcast copy), so pass [] / [] rather than needless aggregate queries.
      // The sender is the viewer of their own just-sent message → mine:true.
      return toMessageDTO(rows[0]!, [], [], input.senderId, input.clientId)
    },

    async editMessage(
      threadId: string,
      messageId: string,
      senderId: string,
      body: string,
    ): Promise<ChatMessageDTO | null> {
      // Sender-only, thread-scoped, not-soft-deleted edit. The WHERE is the authorization gate: it matches a
      // row ONLY when (id, thread_id, sender_id) all line up and the message is live, so a non-sender / wrong
      // thread / missing / soft-deleted target updates nothing and the CTE returns no row (→ null). Stamp
      // edited_at = now() in the DB so the recomputed timestamp matches the persisted row exactly, then read
      // back joined with the sender so `from` is populated (mirrors persist()).
      //
      // No created_at predicate: an edit targets an existing message whose created_at we do not carry, so we
      // cannot prune partitions here. Editing is a rare, deliberate action (not a hot path like the ack
      // watermark), so the unpruned PK seek on (id, created_at) + thread_id across partitions is acceptable.
      const rows = await sql<DmRowSelect[]>`
        WITH updated AS (
          UPDATE dm_messages
          SET body = ${body}, edited_at = now()
          WHERE id = ${messageId}
            AND thread_id = ${threadId}
            AND sender_id = ${senderId}
            AND deleted_at IS NULL
          RETURNING id, thread_id, sender_id, body, kind, attachments, created_at, edited_at, deleted_at
        )
        SELECT
          updated.id,
          updated.thread_id,
          updated.sender_id,
          updated.body,
          updated.kind,
          updated.attachments,
          updated.created_at,
          updated.edited_at,
          updated.deleted_at,
          u.display_name AS sender_display_name,
          u.handle AS sender_handle,
          u.bio AS sender_bio,
          u.deleted_at AS sender_deleted_at
        FROM updated
        JOIN users u ON u.id = updated.sender_id
      `
      const row = rows[0]
      if (!row) return null
      // An edit does not change reactions/mentions, but read them back so the returned DTO is complete.
      const [reactions, mentions] = await Promise.all([
        loadChatReactions(sql, row.id, senderId),
        loadChatMentions(sql, row.id),
      ])
      return toMessageDTO(row, reactions, mentions, senderId)
    },

    async softDelete(
      threadId: string,
      messageId: string,
      senderId: string,
    ): Promise<ChatMessageDTO | null> {
      // SENDER-ONLY, thread-scoped, not-already-deleted (mirror editMessage's WHERE gate exactly but SET
      // deleted_at = now()). A 0-row update returns null → the route maps it to a generic 403. Read the
      // tombstoned row back joined with the sender so the returned DTO is complete.
      const rows = await sql<DmRowSelect[]>`
        WITH updated AS (
          UPDATE dm_messages
          SET deleted_at = now()
          WHERE id = ${messageId}
            AND thread_id = ${threadId}
            AND sender_id = ${senderId}
            AND deleted_at IS NULL
          RETURNING id, thread_id, sender_id, body, kind, attachments, created_at, edited_at, deleted_at
        )
        SELECT
          updated.id,
          updated.thread_id,
          updated.sender_id,
          updated.body,
          updated.kind,
          updated.attachments,
          updated.created_at,
          updated.edited_at,
          updated.deleted_at,
          u.display_name AS sender_display_name,
          u.handle AS sender_handle,
          u.bio AS sender_bio,
          u.deleted_at AS sender_deleted_at
        FROM updated
        JOIN users u ON u.id = updated.sender_id
      `
      const row = rows[0]
      if (!row) return null
      // A tombstone carries no live reactions/mentions to recompute; the body is the deleted marker the
      // client renders via deletedAt.
      return toMessageDTO(row, [], [], senderId)
    },

    async history(
      threadId: string,
      before: string | undefined,
      limit: number,
      viewerUserId: string | null = null,
    ): Promise<ChatHistoryPage> {
      // Resolve the `before` cursor id to its (created_at) so we can keyset strictly older than it. The
      // anchor lookup is SCOPED TO THIS thread: a `before` id from another thread (or unknown/soft-deleted)
      // finds no anchor, so we return the newest page (defensive), and a foreign cursor can never seek into
      // or leak another thread's ordering. Mirrors the cleanup chat repo (P1-5).
      let anchor: { createdAt: Date; id: string } | null = null
      if (before !== undefined) {
        const rows = await sql<{ created_at: Date; id: string }[]>`
          SELECT created_at, id FROM dm_messages
          WHERE id = ${before} AND thread_id = ${threadId} AND deleted_at IS NULL
          LIMIT 1
        `
        if (rows[0]) anchor = { createdAt: rows[0].created_at, id: rows[0].id }
      }

      const cursorFilter =
        anchor !== null
          ? sql`AND (dm.created_at, dm.id) < (${anchor.createdAt}, ${anchor.id}::uuid)`
          : sql``

      const rows = await sql<DmRowSelect[]>`
        SELECT
          dm.id,
          dm.thread_id,
          dm.sender_id,
          dm.body,
          dm.kind,
          dm.attachments,
          dm.created_at,
          dm.edited_at,
          dm.deleted_at,
          u.display_name AS sender_display_name,
          u.handle AS sender_handle,
          u.bio AS sender_bio,
          u.deleted_at AS sender_deleted_at
        FROM dm_messages dm
        JOIN users u ON u.id = dm.sender_id
        WHERE dm.thread_id = ${threadId}
          AND dm.deleted_at IS NULL
          ${cursorFilter}
        ORDER BY dm.created_at DESC, dm.id DESC
        LIMIT ${limit + 1}
      `
      const hasMore = rows.length > limit
      const page = hasMore ? rows.slice(0, limit) : rows
      // Hydrate each row's reaction summary. The history read is not viewer-scoped here (it mirrors the
      // existing signature), so `mine` is computed against no viewer (false); the per-message read path
      // (findMessage) carries the viewer for the toggle response.
      const items = await Promise.all(
        page.map(async (r) => {
          const [reactions, mentions] = await Promise.all([
            loadChatReactions(sql, r.id, viewerUserId),
            loadChatMentions(sql, r.id),
          ])
          return toMessageDTO(r, reactions, mentions, viewerUserId)
        }),
      )
      const last = page[page.length - 1]
      const nextCursor = hasMore && last ? last.id : null
      return { items, nextCursor }
    },

    async findMessage(
      threadId: string,
      messageId: string,
      viewerUserId: string | null,
    ): Promise<ChatMessageDTO | null> {
      const rows = await sql<DmRowSelect[]>`
        SELECT
          dm.id,
          dm.thread_id,
          dm.sender_id,
          dm.body,
          dm.kind,
          dm.attachments,
          dm.created_at,
          dm.edited_at,
          dm.deleted_at,
          u.display_name AS sender_display_name,
          u.handle AS sender_handle,
          u.bio AS sender_bio,
          u.deleted_at AS sender_deleted_at
        FROM dm_messages dm
        JOIN users u ON u.id = dm.sender_id
        WHERE dm.id = ${messageId} AND dm.thread_id = ${threadId} AND dm.deleted_at IS NULL
        LIMIT 1
      `
      const row = rows[0]
      if (!row) return null
      const [reactions, mentions] = await Promise.all([
        loadChatReactions(sql, row.id, viewerUserId),
        loadChatMentions(sql, row.id),
      ])
      return toMessageDTO(row, reactions, mentions, viewerUserId)
    },

    toggleReaction(messageId: string, userId: string, emoji: ReactionEmoji): Promise<boolean> {
      return toggleChatReaction(sql, messageId, userId, emoji)
    },

    async markRead(threadId: string, userId: string, at: Date): Promise<void> {
      // Monotonic upsert: GREATEST so an out-of-order ack never moves the watermark back.
      await sql`
        INSERT INTO dm_read_state (thread_id, user_id, last_read_at)
        VALUES (${threadId}, ${userId}, ${at})
        ON CONFLICT (thread_id, user_id) DO UPDATE
        SET last_read_at = GREATEST(COALESCE(dm_read_state.last_read_at, to_timestamp(0)), ${at})
      `
    },

    async lastReadAt(threadId: string, userId: string): Promise<Date | null> {
      const rows = await sql<{ last_read_at: Date | null }[]>`
        SELECT last_read_at FROM dm_read_state
        WHERE thread_id = ${threadId} AND user_id = ${userId}
      `
      return rows[0]?.last_read_at ?? null
    },

    async resolveMessageCreatedAt(threadId: string, messageId: string): Promise<Date | null> {
      // PARTITION PRUNING: dm_messages is PARTITIONED BY RANGE(created_at) per calendar month (0009).
      // This resolves a DM read-ack watermark, and an ack is always for a very recently received message,
      // so bounding to the last 90 days lets the planner prune to the few recent partitions instead of
      // probing the PK index in EVERY monthly partition. (Unlike the history `before` cursor above — which
      // may legitimately anchor on an old message and is therefore left unbounded — an ack target older
      // than the 90-day window, or an unknown/foreign id, resolves to null here and the caller falls back
      // to now(): the same accepted liveness-precision tradeoff as chat.routes.ts resolveReadAt.)
      const rows = await sql<{ created_at: Date }[]>`
        SELECT created_at FROM dm_messages
        WHERE id = ${messageId} AND thread_id = ${threadId} AND created_at >= now() - interval '90 days'
        LIMIT 1
      `
      return rows[0]?.created_at ?? null
    },

    async listThreadsForUser(userId: string): Promise<DmThreadAggregate[]> {
      // For each thread the user participates in, find the OTHER participant (peer), the last non-deleted
      // message, and the unread count (peer's messages after max(thread.created_at, last_read_at)). Exclude
      // any thread where EITHER party blocked the other (NOT EXISTS over user_blocks both directions).
      const rows = await sql<
        {
          thread_id: string
          thread_created_at: Date
          peer_id: string
          peer_display_name: string
          peer_handle: string | null
          peer_bio: string | null
          peer_avatar_url: string | null
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
          AND peer.deleted_at IS NULL
        LEFT JOIN dm_read_state rs ON rs.thread_id = t.id AND rs.user_id = ${userId}
        LEFT JOIN LATERAL (
          SELECT dm.body, dm.created_at, dm.sender_id
          FROM dm_messages dm
          WHERE dm.thread_id = t.id AND dm.deleted_at IS NULL
          ORDER BY dm.created_at DESC, dm.id DESC
          LIMIT 1
        ) last_msg ON TRUE
        WHERE (t.user_lo = ${userId} OR t.user_hi = ${userId})
          AND NOT EXISTS (
            SELECT 1 FROM user_blocks b
            WHERE (b.blocker_id = ${userId} AND b.blocked_id = peer.id)
               OR (b.blocker_id = peer.id AND b.blocked_id = ${userId})
          )
        ORDER BY COALESCE(last_msg.created_at, t.created_at) DESC
      `
      return rows.map((r) => ({
        threadId: r.thread_id,
        createdAt: r.thread_created_at,
        peer: {
          id: r.peer_id,
          displayName: r.peer_display_name,
          handle: r.peer_handle,
          bio: r.peer_bio,
          avatarUrl: r.peer_avatar_url,
        },
        last:
          r.last_created_at !== null
            ? { body: r.last_body, createdAt: r.last_created_at, senderId: r.last_sender_id! }
            : null,
        unread: Number(r.unread),
      }))
    },
  }
}
