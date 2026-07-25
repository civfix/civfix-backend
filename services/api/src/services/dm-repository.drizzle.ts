/**
 * Postgres-backed DmRepository: the persistence seam for 1:1 direct messages.
 *
 * Separate from the cleanup chat stack (chat_messages / cleanup_members) so cleanup group chat stays
 * byte-for-byte unchanged. dm_messages mirrors chat_messages exactly (declaratively partitioned by
 * RANGE(created_at), PK(id, created_at) — see 0009_dm_and_privacy.sql), so the persist/history code here
 * mirrors chat-repository.drizzle.ts: the read joins the sender's user row to build ChatMessageDTO.from,
 * and history pages newest-first over (created_at, id) with a room-scoped cursor anchor.
 *
 * Because those reads were LITERAL twins of the chat repository's, they now run through the
 * table-parameterized core in chat-room-scope.drizzle.ts (history + around-window + one-row seek + pin
 * flip + pin list), bound below by a RoomScopeSql descriptor over (dm_messages, thread_id) — so a fix to
 * the cursor/window/pin semantics can no longer land on one table and miss the other. What stays here is
 * what genuinely differs: the flat dm row and its DTO mapping (no SYSTEM rows, no @city chips, no polls),
 * the INNER users join, the writes, and the dm-only surface (threads, peers, read state, blocks).
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
import { loadChatReactions, loadChatReactionsFor, toggleChatReaction } from "./chat-reactions.drizzle.js"
import { loadChatMentions, loadChatMentionsFor } from "./chat-mentions.drizzle.js"
import { attachChatMedia, loadChatAttachments } from "./chat-attachments.drizzle.js"
import { monotonicReadWatermark } from "./chat-read-state.drizzle.js"
import { assertReplyTarget, replyMapForRows } from "./chat-reply-hydration.js"
import type { TimeCursor } from "../db/cursor-helpers.js"
import type { PresignMedia } from "./media-presign.js"
import {
  roomFindMessage,
  roomHistory,
  roomListPins,
  roomSetPinned,
  type RoomScopeSql,
} from "./chat-room-scope.drizzle.js"

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
  /** Finalized media upload ids to bind to this message (mirrors PersistChatInput.mediaUploadIds). */
  mediaUploadIds?: string[]
  /** Reply threading (P2): id of the dm message this one replies to (same thread; mirrors PersistChatInput). */
  replyToId?: string
}

/**
 * Lightweight per-message metadata for the edit gate ladder (chat-edit-service). Resolved by message id
 * ALONE (no thread scope, INCLUDING soft-deleted rows) so the caller can distinguish wrong-thread (404) /
 * deleted (409) / non-text (422) / stale (window) before writing. DM rows always carry a sender.
 */
export interface DmMessageMeta {
  id: string
  threadId: string
  senderId: string
  kind: ChatMessageKind
  createdAt: Date
  deletedAt: Date | null
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
  /** Resolve edit-gate metadata by message id alone (soft-deleted rows included). Null when unknown. */
  findMessageMeta(messageId: string): Promise<DmMessageMeta | null>
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
  /**
   * Pin/unpin a dm message (P3), mirroring the chat repo's setPinned: the gated UPDATE flips
   * (pinned_at, pinned_by) only when the row is in THIS thread, live, non-system, and the pin state
   * actually changes (idempotent — a repeat pin keeps the original pinned_at). Returns the CURRENT
   * hydrated DTO either way (null when missing from the thread or tombstoned). Authorization (both
   * participants may pin) lives in the route via the chat-powers resolver.
   */
  setPinned(
    threadId: string,
    messageId: string,
    userId: string,
    pinned: boolean,
  ): Promise<ChatMessageDTO | null>
  /** The thread's pinned messages, newest-pin first (pinned_at DESC), capped at PIN_LIST_CAP. */
  listPins(threadId: string, viewerUserId: string | null): Promise<ChatMessageDTO[]>
  /** Page a thread's messages newest-first, before the given message id (cursor). roomKind:"dm".
   *  `viewerUserId` (optional) resolves each message's reaction `mine` flag for the loader.
   *  `around` (P2 2.4) centers the page on that message id instead (mutually exclusive with `before`). */
  history(
    threadId: string,
    before: string | undefined,
    limit: number,
    viewerUserId?: string | null,
    around?: string,
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
  /**
   * The viewer's unread count for ONE thread, on exactly the definition the inbox aggregate uses
   * (listThreadsForUser): live messages from the PEER strictly after max(thread.created_at,
   * last_read_at). Single-sourced with that subquery so the count a freshly-opened thread reports can
   * never disagree with the count the inbox row shows for the same thread.
   */
  countUnread(threadId: string, userId: string): Promise<number>
  /** Resolve a message's created_at (scoped to the thread), for the ack watermark. Null when unknown. */
  resolveMessageCreatedAt(threadId: string, messageId: string): Promise<Date | null>
  /**
   * The viewer's dm threads (excluding any where either party blocked the other), each with the peer,
   * the last message, and the unread count. Drives the threads UNION. `limit` caps the DB scan so a heavy
   * user's full thread set isn't materialized on every inbox load (the merge in threads-service slices the
   * combined cleanup+dm set, so capping each half is sufficient).
   */
  listThreadsForUser(
    userId: string,
    limit?: number,
    cursor?: TimeCursor | null,
  ): Promise<DmThreadAggregate[]>
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
  // Reply threading (P2): the quoted dm message's id (same table), or NULL for a plain message.
  reply_to_id: string | null
  // Pin state (P3): when the message was pinned to its thread; NULL = not pinned.
  pinned_at: Date | null
  sender_display_name: string
  sender_handle: string | null
  sender_bio: string | null
  sender_avatar_url: string | null
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
  attachments: MediaDTO[] = [],
  // Hydrated reply preview for r.reply_to_id (chat-reply-hydration); null = target unavailable.
  replyTo?: ReplyToDTO | null,
): ChatMessageDTO {
  // PUBLIC author identity: a deleted (tombstoned) sender renders "Deleted User" (no handle/avatar, deleted:true).
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
    // Presigned, status-"ready" media from media_assets (NOT the vestigial dm_messages.attachments jsonb
    // column, which is no longer projected). Always an array.
    attachments,
    reactions,
    mentions,
    createdAt: r.created_at.toISOString(),
    ...(r.edited_at !== null ? { editedAt: r.edited_at.toISOString() } : {}),
    ...(r.deleted_at !== null ? { deletedAt: r.deleted_at.toISOString() } : {}),
    // Reply threading (P2): target id passthrough + the hydrated preview (mirrors the chat repo).
    ...(r.reply_to_id !== null ? { replyToId: r.reply_to_id, replyTo: replyTo ?? null } : {}),
    // Pinning (P3): pinnedAt rides on every read so history rows and message_update broadcasts agree.
    ...(r.pinned_at != null ? { pinnedAt: r.pinned_at.toISOString() } : {}),
    mine: viewerUserId != null && r.sender_id === viewerUserId,
    ...(clientId !== undefined ? { clientId } : {}),
  }
}

/**
 * The `SELECT <dm row + sender columns> FROM <cte> JOIN users` projection that the three CTE-returning
 * writes (persist / editMessage / softDelete) read their row back through — ONE definition instead of
 * three copies of the same 16-column list, which is how one copy loses a column without looking wrong.
 * Mirrors chat-repository's selectChatRowFrom: `cte` is a trusted internal identifier rendered via
 * sql(...) as an ident, and the tag is a parameter so the projection can also run on a transaction handle.
 */
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

/**
 * @param presign OPTIONAL media presigner (see makeDrizzleChatRepository). When supplied, dm message
 *   attachments (media_assets bound by `chat_message_id`, status "ready") are presigned on read and a
 *   send's `mediaUploadIds` are bound to the new message. Omit it (offline tests) to project `[]`.
 */
export function makeDrizzleDmRepository(sql: Sql, presign?: PresignMedia): DmRepository {
  /** The dm row + sender column list for reads off the `dm` alias (history/around/findMessage). */
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

  /**
   * Batch-hydrate a page of dm rows into wire DTOs (attachments/reactions/mentions/reply previews, ONE
   * grouped query each — 4 round-trips per page, not 4×N). Shared by the before-mode page and the
   * around-mode window so both hydrate identically. The reaction `mine` flag resolves for the viewer.
   */
  async function hydrateDmRows(
    page: DmRowSelect[],
    viewerUserId: string | null,
  ): Promise<ChatMessageDTO[]> {
    const ids = page.map((r) => r.id)
    const [attachmentsByMessage, reactionsByMessage, mentionsByMessage, replyByTarget] =
      await Promise.all([
        presign ? loadChatAttachments(sql, ids, presign) : Promise.resolve(new Map<string, MediaDTO[]>()),
        loadChatReactionsFor(sql, ids, viewerUserId),
        loadChatMentionsFor(sql, ids),
        replyMapForRows(sql, "dm_messages", page),
      ])
    return page.map((r) =>
      toMessageDTO(
        r,
        reactionsByMessage.get(r.id) ?? [],
        mentionsByMessage.get(r.id) ?? [],
        viewerUserId,
        undefined,
        attachmentsByMessage.get(r.id) ?? [],
        r.reply_to_id !== null ? replyByTarget.get(r.reply_to_id) ?? null : null,
      ),
    )
  }

  /**
   * Single-row hydration for the one-row seek: the same inputs hydrateDmRows batches, on the single-id
   * loaders. An edit changes neither reactions/mentions nor attachments, but the DTO carries them all so
   * the client can reconcile the message in place without blanking the bubble's media.
   */
  async function hydrateDmRow(row: DmRowSelect, viewerUserId: string | null): Promise<ChatMessageDTO> {
    const [reactions, mentions, attachmentsByMessage, replyByTarget] = await Promise.all([
      loadChatReactions(sql, row.id, viewerUserId),
      loadChatMentions(sql, row.id),
      presign ? loadChatAttachments(sql, [row.id], presign) : Promise.resolve(new Map<string, MediaDTO[]>()),
      replyMapForRows(sql, "dm_messages", [row]),
    ])
    return toMessageDTO(
      row,
      reactions,
      mentions,
      viewerUserId,
      undefined,
      attachmentsByMessage.get(row.id) ?? [],
      row.reply_to_id !== null ? replyByTarget.get(row.reply_to_id) ?? null : null,
    )
  }

  /**
   * The descriptor the shared room-scope core (chat-room-scope.drizzle.ts) reads dm_messages through: ONE
   * thread, scoped on thread_id, with an INNER users join (every dm row has a live-or-tombstoned sender
   * row) and no side context — there is no dm equivalent of a report's jurisdiction.
   */
  function roomSql(threadId: string): RoomScopeSql<DmRowSelect, null> {
    return {
      table: "dm_messages",
      alias: "dm",
      scope: (prefix) =>
        prefix === null ? sql`thread_id = ${threadId}` : sql`${sql(prefix)}.thread_id = ${threadId}`,
      columns: dmColumns,
      from: sql`FROM dm_messages dm JOIN users u ON u.id = dm.sender_id`,
      context: () => Promise.resolve(null),
      hydratePage: (rows, viewerUserId) => hydrateDmRows(rows, viewerUserId),
      hydrateOne: hydrateDmRow,
    }
  }

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
      const uploadIds = input.mediaUploadIds ?? []
      const wantsMedia = !!presign && uploadIds.length > 0
      // Insert, then read back joined with the sender so `from` is populated. created_at defaults to now()
      // in the DB; we read it back rather than guessing so the DTO matches the persisted row exactly. With
      // media, the INSERT + the media-attach run in ONE transaction (mirroring the cleanup chat repo +
      // discussion create) so a failed attach rolls the message back rather than orphaning it (a duplicate on
      // the client's retry). Presigning happens AFTER commit (a network round-trip must not hold the tx open).
      // Reply validation (P2): the target must exist in THIS thread and not be tombstoned — 422 with
      // fields.code reply_wrong_room / reply_deleted_target otherwise. Returns the hydrated preview so
      // the ack/broadcast DTO carries replyTo without a re-read.
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
            await attachChatMedia(tx, inserted[0]!.id, uploadIds)
            return inserted
          })
        : await run(sql)
      // Hydrate the just-attached, ready (presigned) attachments for the returned DTO. A freshly-inserted
      // message has no reactions/mentions yet, so pass [] / []. The sender is the viewer → mine:true.
      const messageId = rows[0]!.id
      const attachments = wantsMedia
        ? (await loadChatAttachments(sql, [messageId], presign!)).get(messageId) ?? []
        : []
      return toMessageDTO(rows[0]!, [], [], input.senderId, input.clientId, attachments, replyTo)
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
          RETURNING id, thread_id, sender_id, body, kind, attachments, created_at, edited_at, deleted_at, reply_to_id, pinned_at
        )
        ${selectDmRowFrom(sql, "updated")}
      `
      const row = rows[0]
      if (!row) return null
      // Hydrated exactly like a one-row seek (reactions/mentions/attachments/reply preview) so the edited
      // DTO is complete — see hydrateDmRow.
      return hydrateDmRow(row, senderId)
    },

    async findMessageMeta(messageId: string): Promise<DmMessageMeta | null> {
      // Id-only seek (probes every partition, like editMessage — acceptable for the rare edit path),
      // INCLUDING soft-deleted rows so the caller can 409 a tombstone rather than 404 it.
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
          RETURNING id, thread_id, sender_id, body, kind, attachments, created_at, edited_at, deleted_at, reply_to_id, pinned_at
        )
        ${selectDmRowFrom(sql, "updated")}
      `
      const row = rows[0]
      if (!row) return null
      // A tombstone carries no live reactions/mentions to recompute; the body is the deleted marker the
      // client renders via deletedAt. Its replyTo preview is kept so the message_update DTO stays
      // shape-consistent with history rows.
      const replyByTarget = await replyMapForRows(sql, "dm_messages", [row])
      return toMessageDTO(
        row,
        [],
        [],
        senderId,
        undefined,
        [],
        row.reply_to_id !== null ? replyByTarget.get(row.reply_to_id) ?? null : null,
      )
    },

    history(
      threadId: string,
      before: string | undefined,
      limit: number,
      viewerUserId: string | null = null,
      around?: string,
    ): Promise<ChatHistoryPage> {
      // Before-mode paging (thread-scoped keyset anchor, so a foreign cursor can never seek into or leak
      // another thread's ordering) and around-mode windows both live in the shared room-scope core.
      return roomHistory(sql, roomSql(threadId), before, limit, viewerUserId, around)
    },

    findMessage(
      threadId: string,
      messageId: string,
      viewerUserId: string | null,
    ): Promise<ChatMessageDTO | null> {
      return roomFindMessage(sql, roomSql(threadId), messageId, viewerUserId)
    },

    toggleReaction(messageId: string, userId: string, emoji: ReactionEmoji): Promise<boolean> {
      return toggleChatReaction(sql, messageId, userId, emoji)
    },

    async markRead(threadId: string, userId: string, at: Date): Promise<void> {
      await monotonicReadWatermark(sql, "dm_read_state", { thread_id: threadId, user_id: userId }, at)
    },

    async lastReadAt(threadId: string, userId: string): Promise<Date | null> {
      const rows = await sql<{ last_read_at: Date | null }[]>`
        SELECT last_read_at FROM dm_read_state
        WHERE thread_id = ${threadId} AND user_id = ${userId}
      `
      return rows[0]?.last_read_at ?? null
    },

    async countUnread(threadId: string, userId: string): Promise<number> {
      // The SAME predicate as listThreadsForUser's `unread` subquery, scoped to one thread: live messages
      // NOT written by the viewer (a 2-party thread has no third author, and dm has no sender-less system
      // rows) strictly after max(thread.created_at, last_read_at). to_timestamp(0) is the never-read
      // baseline, so a thread with no dm_read_state row counts every peer message since it was created.
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

    async listThreadsForUser(
      userId: string,
      limit?: number,
      cursor?: TimeCursor | null,
    ): Promise<DmThreadAggregate[]> {
      // For each thread the user participates in, find the OTHER participant (peer), the last non-deleted
      // message, and the unread count (peer's messages after max(thread.created_at, last_read_at)). Exclude
      // any thread where EITHER party blocked the other (NOT EXISTS over user_blocks both directions).
      // Cap the scan when a limit is supplied so a heavy user's full thread set isn't materialized per load.
      const limitClause = limit !== undefined ? sql`LIMIT ${limit}` : sql``
      // The dm half of the inbox keyset (THREADS_CURSOR in threads-service.ts). The activity bound is the
      // cursor's millisecond or older — an ISO cursor is millisecond-resolution while created_at is not —
      // with the thread id as the tie-break; the threads service re-applies the exact cut on the merge.
      let cursorFilter = sql``
      if (cursor !== null && cursor !== undefined) {
        const msCeiling = new Date(cursor.at.getTime() + 1)
        cursorFilter = sql`
          AND COALESCE(last_msg.created_at, t.created_at) < ${msCeiling}
          AND (COALESCE(last_msg.created_at, t.created_at) < ${cursor.at} OR t.id < ${cursor.id}::uuid)
        `
      }
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
          ${cursorFilter}
        ORDER BY COALESCE(last_msg.created_at, t.created_at) DESC, t.id DESC
        ${limitClause}
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

    setPinned(
      threadId: string,
      messageId: string,
      userId: string,
      pinned: boolean,
    ): Promise<ChatMessageDTO | null> {
      // Gated on thread scope + live row + non-system kind + an ACTUAL state change, then a re-read of the
      // current hydrated DTO either way (idempotent responses) — see the shared core.
      return roomSetPinned(sql, roomSql(threadId), messageId, userId, pinned)
    },

    listPins(threadId: string, viewerUserId: string | null): Promise<ChatMessageDTO[]> {
      return roomListPins(sql, roomSql(threadId), viewerUserId)
    },
  }
}
