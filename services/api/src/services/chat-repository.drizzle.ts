/**
 * Postgres-backed ChatRepository (the persistence half of the chat seam: persist + history).
 *
 * Written against the raw postgres-js tag because the read joins the sender's user row to build the
 * ChatMessageDTO.from PersonDTO, and history pages over the partitioned chat_messages table by
 * (created_at, id). The table is declaratively partitioned by RANGE(created_at) with PK(id, created_at)
 * (see 0002_chat_partitioning.sql), so we always carry created_at in the keyset.
 *
 * HISTORY PAGINATION (newest-first):
 *   history(cleanupId, before, limit) returns up to `limit` messages ordered created_at DESC, id DESC.
 *   `before` is the id of the last message the client already has; we resolve its created_at and return
 *   only rows strictly older than (created_at, id). nextCursor is the id of the oldest row returned when
 *   another page may exist, else null. Soft-deleted rows (deleted_at not null) are excluded.
 *
 *   CURSOR IS ROOM-SCOPED (P1-5): the anchor lookup that resolves `before` -> (created_at) is scoped to
 *   the SAME cleanup_id (AND deleted_at IS NULL). A `before` id from another room (a client/relay bug or
 *   a malicious caller) does NOT resolve to a foreign message's timestamp; it simply finds no anchor and
 *   we return the newest page, so a cursor can never seek into / leak the ordering of a different room.
 */

import type { Queryable, Sql } from "../db/client.js"
import { avatarGradient } from "@civfix/shared"
import type {
  ChatMessageDTO,
  ChatMessageKind,
  ReactionEmoji,
  ReactionSummaryDTO,
  UserMentionDTO,
} from "@civfix/shared"
import type { ChatHistoryPage, PersistChatInput } from "@civfix/shared/interfaces"
import { loadChatReactions, toggleChatReaction } from "./chat-reactions.drizzle.js"
import { loadChatMentions } from "./chat-mentions.drizzle.js"

/** Canonical UUID shape; the `before` cursor is validated against it before reaching a uuid-column bind. */
const CHAT_CURSOR_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Persistence seam for chat: insert a message + page history. The production impl runs Drizzle/PostGIS;
 * the offline tests pass an in-memory implementation so the WsChatService persist/history paths are
 * exercised with no DB. (joinRoom/leaveRoom/broadcast live in the WS adapter, not here.)
 */
export interface ChatRepository {
  /** Insert a chat message and return it as a ChatMessageDTO (sender joined into `from`). */
  insertMessage(input: PersistChatInput, id: string): Promise<ChatMessageDTO>
  /** Page a cleanup's messages newest-first, before the given message id (cursor). `viewerUserId`
   *  (optional) resolves each message's reaction `mine` flag for the loader. */
  history(
    cleanupId: string,
    before: string | undefined,
    limit: number,
    viewerUserId?: string | null,
  ): Promise<ChatHistoryPage>
  /**
   * Load ONE cleanup message (scoped to its cleanup) as a ChatMessageDTO for the viewer, with reactions
   * aggregated (+ the viewer's `mine` flag). Null when the message does not exist in that cleanup or is
   * soft-deleted. Used by the reaction toggle to validate the target + return the recomputed message.
   */
  findMessage(
    cleanupId: string,
    messageId: string,
    viewerUserId: string | null,
  ): Promise<ChatMessageDTO | null>
  /**
   * Toggle one of a user's emoji reactions on a chat message (insert-or-delete by composite PK). Returns
   * true when the reaction is now PRESENT (added), false when removed. Mirrors discussion repo.toggleReaction.
   */
  toggleReaction(messageId: string, userId: string, emoji: ReactionEmoji): Promise<boolean>
}

/** A chat row joined with its sender's person fields, as selected for the DTO. */
interface ChatRowSelect {
  id: string
  cleanup_id: string
  sender_id: string
  body: string | null
  kind: ChatMessageKind
  attachments: unknown[] | null
  created_at: Date
  edited_at: Date | null
  sender_display_name: string
  sender_handle: string | null
  sender_bio: string | null
}

/**
 * Project a selected chat row into the wire ChatMessageDTO. `reactions` is the aggregated per-emoji summary,
 * `mentions` the resolved USER @-mentions (both empty for a freshly-inserted message; the gateway projects a
 * new send's resolved mentions onto its broadcast copy, and history hydrates them via loadChatMentions).
 */
function toMessageDTO(
  r: ChatRowSelect,
  reactions: ReactionSummaryDTO[],
  mentions: UserMentionDTO[],
  clientId?: string,
): ChatMessageDTO {
  return {
    id: r.id,
    cleanupId: r.cleanup_id,
    from: {
      id: r.sender_id,
      name: r.sender_display_name,
      handle: r.sender_handle,
      bio: r.sender_bio,
      avatar: avatarGradient(r.sender_id),
      followers: 0,
      following: 0,
      isFollowing: false,
    },
    ...(r.body !== null ? { body: r.body } : {}),
    kind: r.kind,
    ...(r.attachments !== null ? { attachments: r.attachments } : {}),
    reactions,
    mentions,
    createdAt: r.created_at.toISOString(),
    ...(r.edited_at !== null ? { editedAt: r.edited_at.toISOString() } : {}),
    ...(clientId !== undefined ? { clientId } : {}),
  }
}

/** Shared SELECT list (sender joined) for chat reads. */
function chatColumns(sql: Queryable) {
  return sql`
    cm.id,
    cm.cleanup_id,
    cm.sender_id,
    cm.body,
    cm.kind,
    cm.attachments,
    cm.created_at,
    cm.edited_at,
    u.display_name AS sender_display_name,
    u.handle AS sender_handle,
    u.bio AS sender_bio
  `
}

export function makeDrizzleChatRepository(sql: Sql): ChatRepository {
  return {
    async insertMessage(input: PersistChatInput, id: string): Promise<ChatMessageDTO> {
      const kind: ChatMessageKind = input.kind ?? "text"
      // Insert, then read back joined with the sender so `from` is populated. created_at defaults to now()
      // in the DB; we read it back rather than guessing so the DTO matches the persisted row exactly.
      const rows = await sql<ChatRowSelect[]>`
        WITH inserted AS (
          INSERT INTO chat_messages (id, cleanup_id, sender_id, body, kind, attachments)
          VALUES (
            ${id},
            ${input.cleanupId},
            ${input.userId},
            ${input.body},
            ${kind},
            ${input.attachments != null ? sql.json(input.attachments as Parameters<typeof sql.json>[0]) : null}
          )
          RETURNING id, cleanup_id, sender_id, body, kind, attachments, created_at, edited_at
        )
        SELECT
          inserted.id,
          inserted.cleanup_id,
          inserted.sender_id,
          inserted.body,
          inserted.kind,
          inserted.attachments,
          inserted.created_at,
          inserted.edited_at,
          u.display_name AS sender_display_name,
          u.handle AS sender_handle,
          u.bio AS sender_bio
        FROM inserted
        JOIN users u ON u.id = inserted.sender_id
      `
      // A freshly-inserted message has no reactions/mentions persisted yet (the gateway projects a send's
      // resolved mentions onto its broadcast copy), so pass [] / [] rather than needless aggregate queries.
      return toMessageDTO(rows[0]!, [], [], input.clientId)
    },

    async history(
      cleanupId: string,
      before: string | undefined,
      limit: number,
      viewerUserId: string | null = null,
    ): Promise<ChatHistoryPage> {
      // Resolve the `before` cursor id to its (created_at) so we can keyset strictly older than it. The
      // anchor lookup is SCOPED TO THIS cleanup (P1-5): a `before` id that belongs to another room (or is
      // unknown / soft-deleted) finds no anchor, so we just return the newest page (defensive) - a foreign
      // cursor can never seek into or leak another room's ordering. Scoping also lets the planner use the
      // (cleanup_id, created_at) access path instead of probing every partition by id alone.
      let anchor: { createdAt: Date; id: string } | null = null
      // Only look up the anchor when `before` is a well-formed UUID. The lookup binds it against the uuid
      // `id` column, so a non-UUID value would raise a Postgres 22P02 cast error -> 500; a malformed
      // cursor instead degrades to "newest page" (anchor stays null), matching the foreign-cursor handling.
      if (before !== undefined && CHAT_CURSOR_UUID_RE.test(before)) {
        const rows = await sql<{ created_at: Date; id: string }[]>`
          SELECT created_at, id FROM chat_messages
          WHERE id = ${before} AND cleanup_id = ${cleanupId} AND deleted_at IS NULL
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
        JOIN users u ON u.id = cm.sender_id
        WHERE cm.cleanup_id = ${cleanupId}
          AND cm.deleted_at IS NULL
          ${cursorFilter}
        ORDER BY cm.created_at DESC, cm.id DESC
        LIMIT ${limit + 1}
      `
      const hasMore = rows.length > limit
      const page = hasMore ? rows.slice(0, limit) : rows
      // Hydrate each row's reaction summary (with `mine` resolved for the viewer). The history read is not
      // viewer-scoped here (it mirrors the existing signature), so `mine` is computed against no viewer
      // (false); the per-message read path (findMessage) carries the viewer for the toggle response.
      const items = await Promise.all(
        page.map(async (r) => {
          const [reactions, mentions] = await Promise.all([
            loadChatReactions(sql, r.id, viewerUserId),
            loadChatMentions(sql, r.id),
          ])
          return toMessageDTO(r, reactions, mentions)
        }),
      )
      const last = page[page.length - 1]
      const nextCursor = hasMore && last ? last.id : null
      return { items, nextCursor }
    },

    async findMessage(
      cleanupId: string,
      messageId: string,
      viewerUserId: string | null,
    ): Promise<ChatMessageDTO | null> {
      const rows = await sql<ChatRowSelect[]>`
        SELECT ${chatColumns(sql)}
        FROM chat_messages cm
        JOIN users u ON u.id = cm.sender_id
        WHERE cm.id = ${messageId} AND cm.cleanup_id = ${cleanupId} AND cm.deleted_at IS NULL
        LIMIT 1
      `
      const row = rows[0]
      if (!row) return null
      const [reactions, mentions] = await Promise.all([
        loadChatReactions(sql, row.id, viewerUserId),
        loadChatMentions(sql, row.id),
      ])
      return toMessageDTO(row, reactions, mentions)
    },

    toggleReaction(messageId: string, userId: string, emoji: ReactionEmoji): Promise<boolean> {
      return toggleChatReaction(sql, messageId, userId, emoji)
    },
  }
}
