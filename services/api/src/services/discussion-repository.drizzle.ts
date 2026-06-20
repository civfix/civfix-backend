/**
 * Postgres-backed DiscussionRepository (the production implementation of the discussion persistence seam).
 *
 * ALL report_discussion_messages / report_message_reactions / report_message_mentions / discussion-media
 * access flows through here so the discussion service stays infra-free and unit-testable with an in-memory
 * repo. Written against the raw postgres-js tag (`Sql`) like the reports repo, since createMessage runs as a
 * SINGLE transaction (sql.begin): insert the message, attach media (the same unattached-or-own rule report
 * create uses, never stealing a foreign asset), and record the @mention row - all atomically.
 *
 * READ SHAPE. Each message record is assembled with:
 *   - the author person fields (LEFT JOIN users; null for a system / soft-removed row),
 *   - replyCount = count of NON-deleted direct children,
 *   - reactions aggregated per emoji with a per-viewer `mine` flag (a LEFT JOIN on the viewer's own row),
 *   - attachments (media_assets WHERE discussion_message_id = the message; the service filters to `ready`
 *     and presigns),
 *   - the single @mention (LEFT JOIN report_message_mentions + jurisdictions for the name/handle).
 * Pagination is an oldest-first keyset over (created_at ASC, id ASC), matching the
 * report_discussion_messages_report_parent_created_idx index.
 *
 * Geometry note: this domain touches NO geometry, so unlike the reports repo there is no PostGIS here; the
 * raw tag is used for the transaction + the ANY/aggregate reads, not for geometry.
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
import type { ReactionEmoji, ReportCategory, UserMentionDTO } from "@civfix/shared"

/** A discussion message row as selected back (author joined; counts/reactions/attachments loaded after). */
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
  author_deleted_at: Date | null
  reply_count: number
  mention_geoid: string | null
  mention_name: string | null
  mention_handle: string | null
  mention_forwarded_at: Date | null
}

/** Shared SELECT list (author + replyCount + mention) for a single message keyed by the viewer. */
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

/** FROM + joins shared by every message read (author, the single mention + its jurisdiction). */
function messageFrom(tag: Queryable) {
  return tag`
    FROM report_discussion_messages m
    LEFT JOIN users u ON u.id = m.author_user_id
    LEFT JOIN report_message_mentions mn ON mn.message_id = m.id
    LEFT JOIN jurisdictions jm ON jm.geoid = mn.geoid
  `
}

export function makeDrizzleDiscussionRepository(sql: Sql): DiscussionRepository {
  /** Load the `ready`/in-flight media attached to a message (raw keys; the service presigns + filters). */
  async function loadAttachments(
    tag: Queryable,
    messageId: string,
  ): Promise<DiscussionMediaView[]> {
    const rows = await tag<
      {
        id: string
        kind: "image" | "video"
        codec: string | null
        r2_key: string
        thumb_key: string | null
        status: "validating" | "ready" | "rejected" | "held"
        width: number | null
        height: number | null
      }[]
    >`
      SELECT id, kind, codec, r2_key, thumb_key, status, width, height
      FROM media_assets
      WHERE discussion_message_id = ${messageId}
      ORDER BY created_at ASC
    `
    return rows.map((m) => ({
      id: m.id,
      kind: m.kind,
      codec: m.codec,
      r2Key: m.r2_key,
      thumbKey: m.thumb_key,
      status: m.status,
      width: m.width,
      height: m.height,
    }))
  }

  /** Aggregate per-emoji reaction counts for a message, with a `mine` flag for the viewer (null = none). */
  async function loadReactions(
    tag: Queryable,
    messageId: string,
    viewerUserId: string | null,
  ): Promise<DiscussionReactionView[]> {
    const rows = await tag<{ emoji: string; count: number; mine: boolean }[]>`
      SELECT
        emoji,
        count(*)::int AS count,
        bool_or(user_id = ${viewerUserId}) AS mine
      FROM report_message_reactions
      WHERE message_id = ${messageId}
      GROUP BY emoji
      ORDER BY emoji ASC
    `
    return rows.map((r) => ({ emoji: r.emoji, count: r.count, mine: viewerUserId !== null && r.mine }))
  }

  /** Load the resolved USER @-mentions on a message (report_message_user_mentions joined to users). */
  async function loadUserMentions(
    tag: Queryable,
    messageId: string,
  ): Promise<UserMentionDTO[]> {
    const rows = await tag<{ id: string; handle: string | null; display_name: string }[]>`
      SELECT u.id, u.handle, u.display_name
      FROM report_message_user_mentions um
      JOIN users u ON u.id = um.mentioned_user_id
      WHERE um.message_id = ${messageId}
      ORDER BY u.handle ASC, u.id ASC
    `
    // The UserMentionDTO handle is non-null; a mentioned user always has a handle in practice (mentions are
    // resolved from @handles), but coalesce defensively so a NULL-handle row never breaks the contract.
    return rows.map((r) => ({ id: r.id, handle: r.handle ?? "", displayName: r.display_name }))
  }

  /** Project a selected row + its loaded attachments/reactions/userMentions into the service's record shape. */
  function toRecord(
    r: MessageRowSelect,
    attachments: DiscussionMediaView[],
    reactions: DiscussionReactionView[],
    userMentions: UserMentionDTO[],
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

  /** Hydrate a batch of selected rows (attachments + reactions per row), preserving order. */
  async function hydrate(
    tag: Queryable,
    rows: MessageRowSelect[],
    viewerUserId: string | null,
  ): Promise<DiscussionMessageRecord[]> {
    return Promise.all(
      rows.map(async (r) => {
        const [attachments, reactions, userMentions] = await Promise.all([
          loadAttachments(tag, r.id),
          loadReactions(tag, r.id, viewerUserId),
          loadUserMentions(tag, r.id),
        ])
        return toRecord(r, attachments, reactions, userMentions)
      }),
    )
  }

  /**
   * Page messages with a given parent filter (null = top-level), oldest-first keyset. NON-deleted only by
   * default (the public read); pass includeDeleted=true (the operator read) to ALSO return soft-removed
   * rows. The service tombstones a removed row when projecting, so removed content never leaks.
   */
  async function pageMessages(
    reportId: string,
    parentClause: ReturnType<Sql>,
    viewerUserId: string | null,
    cursor: string | null,
    limit: number,
    includeDeleted: boolean,
  ): Promise<{ records: DiscussionMessageRecord[]; nextCursor: string | null }> {
    const anchor = parseCursor(cursor)
    const cursorFilter =
      anchor !== null
        ? sql`AND (m.created_at, m.id) > (${anchor.createdAt}, ${anchor.id}::uuid)`
        : sql``
    // Default public read hides tombstones; the operator read keeps them (no extra predicate).
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
    const nextCursor =
      hasMore && last ? `${last.created_at.toISOString()}|${last.id}` : null
    return { records, nextCursor }
  }

  return {
    async findReportForDiscussion(reportId: string): Promise<DiscussionReportView | null> {
      // Report visibility handle + its resolved jurisdiction (name/handle) + first usable contact email,
      // using the SAME contact precedence as admin getRouting: category-specific -> default -> legacy[1].
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
          (SELECT j.contact_emails[1]) AS legacy_email
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

    async findMessage(
      reportId: string,
      messageId: string,
      viewerUserId: string | null,
    ): Promise<DiscussionMessageRecord | null> {
      const rows = await sql<MessageRowSelect[]>`
        SELECT ${messageColumns(sql)}
        ${messageFrom(sql)}
        WHERE m.id = ${messageId} AND m.report_id = ${reportId}
        LIMIT 1
      `
      const row = rows[0]
      if (!row) return null
      const [hydrated] = await hydrate(sql, [row], viewerUserId)
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
        // 1) Insert the message.
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

        // 2) Attach media: bind only an upload whose discussion_message_id is NULL (unattached) or already
        // this message; never steal a foreign attachment. Mirrors the report-create media-attach rule. A
        // ready/validating asset is linkable; held/rejected stay (they are simply not served on read).
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

        // 3) Record the @city mention row when present (composite PK de-dupes a repeat geoid).
        if (args.mention !== null) {
          await tx`
            INSERT INTO report_message_mentions (message_id, geoid, forwarded_at)
            VALUES (${args.messageId}, ${args.mention.geoid}, ${args.mention.forwardedAt})
            ON CONFLICT (message_id, geoid) DO NOTHING
          `
        }

        // 4) Record the resolved USER @-mentions (already de-duped + self-excluded by the service). The
        // composite PK (message_id, mentioned_user_id) de-dupes; ON CONFLICT DO NOTHING keeps it idempotent.
        for (const mentionedUserId of args.mentionedUserIds) {
          await tx`
            INSERT INTO report_message_user_mentions (message_id, mentioned_user_id)
            VALUES (${args.messageId}, ${mentionedUserId})
            ON CONFLICT (message_id, mentioned_user_id) DO NOTHING
          `
        }
      })

      // Read the freshly-created message back as a record for the author (the viewer is the creator).
      const rows = await sql<MessageRowSelect[]>`
        SELECT ${messageColumns(sql)}
        ${messageFrom(sql)}
        WHERE m.id = ${args.messageId}
        LIMIT 1
      `
      const [record] = await hydrate(sql, rows, args.authorUserId)
      // The row was just inserted in the committed transaction above, so it must exist.
      return record!
    },

    async editMessage(
      reportId: string,
      messageId: string,
      authorId: string,
      body: string,
      editedAt: Date,
      mediaUploadIds: string[] | undefined,
      mentionedUserIds: string[],
    ): Promise<DiscussionMessageRecord | null> {
      const matched = await sql.begin(async (tx) => {
        // 1) Update the body + stamp edited_at, but ONLY for this report's message authored by authorId and
        // not already soft-removed (a tombstone is not editable). RETURNING tells us whether a row matched;
        // when none did (wrong report / not the author / removed / missing) we bail with the tx untouched.
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

        // 2) Optional attachment REPLACEMENT: when the caller passed mediaUploadIds, swap the message's
        // attachment set. First detach the message's CURRENT attachments (clear discussion_message_id), then
        // bind the given uploads under the SAME unattached-or-own + report-unbound + ready/validating rule
        // createMessage uses (never stealing a foreign asset). Passing [] therefore clears all attachments.
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

        // 3) REPLACE the USER @-mention set: delete the message's current rows, then insert the new resolved
        // set (already de-duped + self-excluded). An edit that drops an @handle therefore drops its row.
        await tx`
          DELETE FROM report_message_user_mentions WHERE message_id = ${messageId}
        `
        for (const mentionedUserId of mentionedUserIds) {
          await tx`
            INSERT INTO report_message_user_mentions (message_id, mentioned_user_id)
            VALUES (${messageId}, ${mentionedUserId})
            ON CONFLICT (message_id, mentioned_user_id) DO NOTHING
          `
        }
        return true
      })
      if (!matched) return null

      // Read the freshly-edited message back as a record for the author (the viewer is the editor).
      const rows = await sql<MessageRowSelect[]>`
        SELECT ${messageColumns(sql)}
        ${messageFrom(sql)}
        WHERE m.id = ${messageId}
        LIMIT 1
      `
      const [record] = await hydrate(sql, rows, authorId)
      // The row was just updated in the committed transaction above, so it must still exist.
      return record ?? null
    },

    async toggleReaction(
      messageId: string,
      userId: string,
      emoji: ReactionEmoji,
    ): Promise<boolean> {
      // Toggle: try to delete an existing (message,user,emoji); if nothing was deleted, insert it. Done in
      // one transaction so a concurrent double-toggle cannot land both a delete and an insert out of order.
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

/**
 * Parse an oldest-first keyset cursor "<iso>|<id>" into its anchor, or null when absent/malformed. A
 * non-UUID id is rejected (it would 22P02 on the `::uuid` cast) and degrades to "from the start".
 */
function parseCursor(cursor: string | null): { createdAt: Date; id: string } | null {
  if (cursor === null) return null
  const idx = cursor.indexOf("|")
  if (idx < 0) return null
  const iso = cursor.slice(0, idx)
  const id = cursor.slice(idx + 1)
  const at = new Date(iso)
  if (Number.isNaN(at.getTime()) || !CURSOR_UUID_RE.test(id)) return null
  return { createdAt: at, id }
}

/** Canonical UUID shape, validated before a cursor id reaches a `::uuid` cast. */
const CURSOR_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
