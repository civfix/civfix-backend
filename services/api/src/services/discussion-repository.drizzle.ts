/**
 * Postgres-backed DiscussionRepository (the production implementation of the discussion persistence seam).
 *
 * Written against the raw postgres-js tag (`Sql`) like the reports repo, since createMessage runs as a
 * SINGLE transaction (sql.begin): insert the message, attach media (the same unattached-or-own rule report
 * create uses, never stealing a foreign asset), and record the @mention rows — all atomically.
 *
 * READ SHAPE: each message record carries the author person fields (LEFT JOIN users; null for a system /
 * soft-removed row), replyCount, per-emoji reactions (with the viewer's `mine`), attachments, the single
 * @city mention, and the resolved USER @-mentions. The relation loads are BATCHED across a page (one
 * `WHERE message_id IN (...)` per relation, grouped into a Map) — never one query per row. Pagination is an
 * oldest-first keyset over (created_at ASC, id ASC), matching report_discussion_messages_report_parent_created_idx.
 */

import type { Queryable, Sql } from "../db/client.js"
import type {
  CreateDiscussionMessageTxArgs,
  DiscussionMediaView,
  DiscussionMessageRecord,
  DiscussionReactionView,
  DiscussionReportView,
  DiscussionRepository,
  ReportJurisdictionView,
} from "./discussion-service.js"
import { loadReactionsFor } from "./message-reactions.drizzle.js"
import { makeMentionRepo, loadMentionsFor } from "./message-mentions.drizzle.js"
import { parseTimeCursor } from "../db/cursor-helpers.js"
import type { ReactionEmoji, ReportCategory } from "@civfix/shared"

interface MessageRowSelect {
  id: string
  report_id: string
  parent_id: string | null
  author_user_id: string | null
  body: string
  forwarded_to_city: boolean
  created_at: Date
  edited_at: Date | null
  deleted_at: Date | null
  author_display_name: string | null
  author_handle: string | null
  author_avatar_url: string | null
  author_deleted_at: Date | null
  reply_count: number
  mention_geoid: string | null
  mention_name: string | null
  mention_handle: string | null
  mention_forwarded_at: Date | null
}

function messageColumns(tag: Queryable) {
  return tag`
    m.id,
    m.report_id,
    m.parent_id,
    m.author_user_id,
    m.body,
    m.forwarded_to_city,
    m.created_at,
    m.edited_at,
    m.deleted_at,
    u.display_name AS author_display_name,
    u.handle AS author_handle,
    u.avatar_url AS author_avatar_url,
    u.deleted_at AS author_deleted_at,
    (
      SELECT count(*)::int FROM report_discussion_messages c
      WHERE c.parent_id = m.id AND c.deleted_at IS NULL
    ) AS reply_count,
    mn.geoid AS mention_geoid,
    jm.name AS mention_name,
    jm.handle AS mention_handle,
    mn.forwarded_at AS mention_forwarded_at
  `
}

function messageFrom(tag: Queryable) {
  return tag`
    FROM report_discussion_messages m
    LEFT JOIN users u ON u.id = m.author_user_id
    LEFT JOIN report_message_mentions mn ON mn.message_id = m.id
    LEFT JOIN jurisdictions jm ON jm.geoid = mn.geoid
  `
}

export function makeDrizzleDiscussionRepository(sql: Sql): DiscussionRepository {
  const mentionRepo = makeMentionRepo(sql, "report_message_user_mentions")

  // Batched: ready attachments for a set of messages, grouped by message id (raw keys; the service presigns
  // + the read is scoped to status='ready' so held/rejected/validating are never served, the EXIF/GPS gate).
  async function loadAttachmentsFor(
    tag: Queryable,
    messageIds: string[],
  ): Promise<Map<string, DiscussionMediaView[]>> {
    const byMessage = new Map<string, DiscussionMediaView[]>()
    if (messageIds.length === 0) return byMessage
    const rows = await tag<
      {
        id: string
        message_id: string
        kind: "image" | "video"
        codec: string | null
        r2_key: string
        thumb_key: string | null
        status: "validating" | "ready" | "rejected" | "held"
        width: number | null
        height: number | null
      }[]
    >`
      SELECT id, discussion_message_id AS message_id, kind, codec, r2_key, thumb_key, status, width, height
      FROM media_assets
      WHERE discussion_message_id IN ${tag(messageIds)}
        AND status = 'ready'
      ORDER BY created_at ASC
    `
    for (const m of rows) {
      const view: DiscussionMediaView = {
        id: m.id,
        kind: m.kind,
        codec: m.codec,
        r2Key: m.r2_key,
        thumbKey: m.thumb_key,
        status: m.status,
        width: m.width,
        height: m.height,
      }
      const list = byMessage.get(m.message_id)
      if (list) list.push(view)
      else byMessage.set(m.message_id, [view])
    }
    return byMessage
  }

  function toRecord(
    r: MessageRowSelect,
    attachments: DiscussionMediaView[],
    reactions: DiscussionReactionView[],
    userMentions: DiscussionMessageRecord["userMentions"],
  ): DiscussionMessageRecord {
    return {
      id: r.id,
      reportId: r.report_id,
      parentId: r.parent_id,
      authorUserId: r.author_user_id,
      author:
        r.author_user_id !== null && r.author_display_name !== null
          ? {
              id: r.author_user_id,
              displayName: r.author_display_name,
              handle: r.author_handle,
              avatarUrl: r.author_avatar_url,
              deletedAt: r.author_deleted_at,
            }
          : null,
      body: r.body,
      forwardedToCity: r.forwarded_to_city,
      createdAt: r.created_at,
      editedAt: r.edited_at,
      deletedAt: r.deleted_at,
      replyCount: r.reply_count,
      attachments,
      reactions,
      userMentions,
      mention:
        r.mention_geoid !== null
          ? {
              geoid: r.mention_geoid,
              name: r.mention_name ?? r.mention_geoid,
              handle: r.mention_handle,
              forwarded: r.mention_forwarded_at !== null,
            }
          : null,
    }
  }

  // Hydrate a batch of selected rows: one grouped query per relation (attachments / reactions / mentions),
  // not three per row — the N+1 fix. Reactions + mentions reuse the shared message-relation loaders.
  async function hydrate(
    tag: Queryable,
    rows: MessageRowSelect[],
    viewerUserId: string | null,
  ): Promise<DiscussionMessageRecord[]> {
    if (rows.length === 0) return []
    const ids = rows.map((r) => r.id)
    const [attachments, reactions, mentions] = await Promise.all([
      loadAttachmentsFor(tag, ids),
      loadReactionsFor(tag, "report_message_reactions", ids, viewerUserId),
      loadMentionsFor(tag, "report_message_user_mentions", ids),
    ])
    return rows.map((r) =>
      toRecord(r, attachments.get(r.id) ?? [], reactions.get(r.id) ?? [], mentions.get(r.id) ?? []),
    )
  }

  async function pageMessages(
    reportId: string,
    parentClause: ReturnType<Sql>,
    viewerUserId: string | null,
    cursor: string | null,
    limit: number,
    includeDeleted: boolean,
  ): Promise<{ records: DiscussionMessageRecord[]; nextCursor: string | null }> {
    const anchor = parseTimeCursor(cursor)
    const cursorFilter =
      anchor !== null
        ? sql`AND (m.created_at, m.id) > (${anchor.at}, ${anchor.id}::uuid)`
        : sql``
    const deletedFilter = includeDeleted ? sql`` : sql`AND m.deleted_at IS NULL`
    const rows = await sql<MessageRowSelect[]>`
      SELECT ${messageColumns(sql)}
      ${messageFrom(sql)}
      WHERE m.report_id = ${reportId}
        AND ${parentClause}
        ${deletedFilter}
        ${cursorFilter}
      ORDER BY m.created_at ASC, m.id ASC
      LIMIT ${limit + 1}
    `
    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const records = await hydrate(sql, page, viewerUserId)
    const last = page[page.length - 1]
    const nextCursor = hasMore && last ? `${last.created_at.toISOString()}|${last.id}` : null
    return { records, nextCursor }
  }

  async function readOne(
    messageId: string,
    viewerUserId: string | null,
  ): Promise<DiscussionMessageRecord | null> {
    const rows = await sql<MessageRowSelect[]>`
      SELECT ${messageColumns(sql)}
      ${messageFrom(sql)}
      WHERE m.id = ${messageId}
      LIMIT 1
    `
    const [record] = await hydrate(sql, rows, viewerUserId)
    return record ?? null
  }

  return {
    async findReportForDiscussion(reportId: string): Promise<DiscussionReportView | null> {
      // Report visibility handle + its resolved jurisdiction + first usable contact email, using the SAME
      // contact precedence as admin getRouting: category-specific -> default -> legacy[1].
      const rows = await sql<
        {
          id: string
          reporter_user_id: string | null
          status: string
          visibility: string
          deleted_at: Date | null
          category: ReportCategory
          place: string | null
          geoid: string | null
          j_name: string | null
          j_handle: string | null
          cat_email: string | null
          default_email: string | null
          legacy_email: string | null
        }[]
      >`
        SELECT
          r.id,
          r.reporter_user_id,
          r.status,
          r.visibility,
          r.deleted_at,
          r.category,
          r.addr AS place,
          j.geoid,
          j.name AS j_name,
          j.handle AS j_handle,
          (SELECT jc.email FROM jurisdiction_contacts jc
             WHERE jc.geoid = j.geoid AND jc.category = r.category
               AND jc.email IS NOT NULL AND jc.email <> '' LIMIT 1) AS cat_email,
          (SELECT jc.email FROM jurisdiction_contacts jc
             WHERE jc.geoid = j.geoid AND jc.category IS NULL
               AND jc.email IS NOT NULL AND jc.email <> '' LIMIT 1) AS default_email,
          j.contact_emails[1] AS legacy_email
        FROM reports r
        LEFT JOIN jurisdictions j ON j.geoid = r.jurisdiction_geoid
        WHERE r.id = ${reportId}
        LIMIT 1
      `
      const row = rows[0]
      if (!row) return null
      const jurisdiction: ReportJurisdictionView | null =
        row.geoid !== null
          ? {
              geoid: row.geoid,
              name: row.j_name ?? row.geoid,
              handle: row.j_handle,
              contactEmail: row.cat_email ?? row.default_email ?? row.legacy_email ?? null,
            }
          : null
      return {
        id: row.id,
        reporterUserId: row.reporter_user_id,
        status: row.status,
        visibility: row.visibility,
        deletedAt: row.deleted_at,
        jurisdiction,
        category: row.category,
        place: row.place,
      }
    },

    async findMessage(reportId, messageId, viewerUserId) {
      const rows = await sql<MessageRowSelect[]>`
        SELECT ${messageColumns(sql)}
        ${messageFrom(sql)}
        WHERE m.id = ${messageId} AND m.report_id = ${reportId}
        LIMIT 1
      `
      const [hydrated] = await hydrate(sql, rows, viewerUserId)
      return hydrated ?? null
    },

    async listTopLevel(reportId, viewerUserId, cursor, limit, includeDeleted = false) {
      return pageMessages(reportId, sql`m.parent_id IS NULL`, viewerUserId, cursor, limit, includeDeleted)
    },

    async listReplies(reportId, parentId, viewerUserId, cursor, limit, includeDeleted = false) {
      return pageMessages(
        reportId,
        sql`m.parent_id = ${parentId}`,
        viewerUserId,
        cursor,
        limit,
        includeDeleted,
      )
    },

    async createMessage(args: CreateDiscussionMessageTxArgs): Promise<DiscussionMessageRecord> {
      await sql.begin(async (tx) => {
        await tx`
          INSERT INTO report_discussion_messages (
            id, report_id, parent_id, author_user_id, body, forwarded_to_city, created_at
          ) VALUES (
            ${args.messageId},
            ${args.reportId},
            ${args.parentId},
            ${args.authorUserId},
            ${args.body},
            ${args.forwardedToCity},
            ${args.createdAt}
          )
        `

        // Bind only an upload whose discussion_message_id is NULL (unattached) or already this message; never
        // steal a foreign attachment. A ready/validating asset is linkable; held/rejected stay (just unserved).
        if (args.mediaUploadIds.length > 0) {
          await tx`
            UPDATE media_assets
            SET discussion_message_id = ${args.messageId}
            WHERE upload_id IN ${tx(args.mediaUploadIds)}
              AND (discussion_message_id IS NULL OR discussion_message_id = ${args.messageId})
              AND report_id IS NULL
              AND status IN ('ready', 'validating')
          `
        }

        if (args.mention !== null) {
          await tx`
            INSERT INTO report_message_mentions (message_id, geoid, forwarded_at)
            VALUES (${args.messageId}, ${args.mention.geoid}, ${args.mention.forwardedAt})
            ON CONFLICT (message_id, geoid) DO NOTHING
          `
        }

        // Resolved USER @-mentions (already de-duped + self-excluded). One batched INSERT…ON CONFLICT.
        await mentionRepo.recordFor(tx, args.messageId, args.mentionedUserIds)
      })

      const record = await readOne(args.messageId, args.authorUserId)
      // The row was just inserted in the committed transaction above, so it must exist.
      return record!
    },

    async editMessage(reportId, messageId, authorId, body, editedAt, mediaUploadIds, mentionedUserIds) {
      const matched = await sql.begin(async (tx) => {
        // The UPDATE's WHERE is the author + not-deleted gate; RETURNING tells us whether a row matched
        // (wrong report / not the author / removed / missing => no match => bail with the tx untouched).
        const updated = await tx<{ id: string }[]>`
          UPDATE report_discussion_messages
          SET body = ${body}, edited_at = ${editedAt}
          WHERE id = ${messageId}
            AND report_id = ${reportId}
            AND author_user_id = ${authorId}
            AND deleted_at IS NULL
          RETURNING id
        `
        if (updated.length === 0) return false

        // Optional attachment REPLACEMENT: detach the message's current attachments, then bind the given
        // uploads under the SAME unattached-or-own + report-unbound + ready/validating rule createMessage
        // uses. Passing [] therefore clears all attachments; omitting leaves the set untouched.
        if (mediaUploadIds !== undefined) {
          await tx`
            UPDATE media_assets
            SET discussion_message_id = NULL
            WHERE discussion_message_id = ${messageId}
          `
          if (mediaUploadIds.length > 0) {
            await tx`
              UPDATE media_assets
              SET discussion_message_id = ${messageId}
              WHERE upload_id IN ${tx(mediaUploadIds)}
                AND (discussion_message_id IS NULL OR discussion_message_id = ${messageId})
                AND report_id IS NULL
                AND status IN ('ready', 'validating')
            `
          }
        }

        // REPLACE the USER @-mention set (delete-then-batched-insert); an edit that drops an @handle drops it.
        await mentionRepo.recordFor(tx, messageId, mentionedUserIds)
        return true
      })
      if (!matched) return null
      return readOne(messageId, authorId)
    },

    async toggleReaction(messageId, userId, emoji: ReactionEmoji): Promise<boolean> {
      // One transaction so a concurrent double-toggle cannot land both a delete and an insert out of order.
      return sql.begin(async (tx) => {
        const deleted = await tx<{ message_id: string }[]>`
          DELETE FROM report_message_reactions
          WHERE message_id = ${messageId} AND user_id = ${userId} AND emoji = ${emoji}
          RETURNING message_id
        `
        if (deleted.length > 0) return false
        await tx`
          INSERT INTO report_message_reactions (message_id, user_id, emoji)
          VALUES (${messageId}, ${userId}, ${emoji})
          ON CONFLICT (message_id, user_id, emoji) DO NOTHING
        `
        return true
      })
    },

    async softDelete(messageId: string, deletedAt: Date): Promise<boolean> {
      const rows = await sql<{ id: string }[]>`
        UPDATE report_discussion_messages
        SET deleted_at = ${deletedAt}
        WHERE id = ${messageId} AND deleted_at IS NULL
        RETURNING id
      `
      return rows.length > 0
    },

    async countTopLevel(reportId: string): Promise<number> {
      const rows = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count
        FROM report_discussion_messages
        WHERE report_id = ${reportId}
          AND parent_id IS NULL
          AND deleted_at IS NULL
      `
      return rows[0]?.count ?? 0
    },
  }
}
