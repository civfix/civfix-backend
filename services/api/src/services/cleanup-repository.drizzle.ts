
import { AppError } from "@civfix/shared"
import type postgres from "postgres"
import type { Queryable, Sql } from "../db/client.js"
import { parseNearCursor, parseTimeCursor } from "../db/cursor-helpers.js"
import { allocateEventReferenceCode } from "../db/reference-code.js"
import type {
  AttendeeView,
  CleanupRecord,
  CleanupRepository,
  CreateCleanupTxArgs,
  LinkedEventView,
  LinkedReportView,
  ListAttendeesArgs,
  ListCleanupsFilters,
  NearPoint,
  UpdateCleanupPatch,
} from "./cleanup-repository.types.js"
import {
  buildBboxFilter,
  buildMembershipFilter,
  buildWhenFilter,
  cleanupColumns,
  goingJoin,
  toRecord,
  type AttendeeRowSelect,
  type CleanupRowSelect,
} from "./cleanup-sql.js"
import type {
  CleanupStatus,
  EventKind,
  ReportCategory,
  ReportStatus,
  ReportType,
} from "@civfix/shared"

export function makeDrizzleCleanupRepository(sql: Sql): CleanupRepository {
  async function readById(
    tag: Queryable,
    id: string,
    near: NearPoint | null,
  ): Promise<CleanupRecord | null> {
    const rows = await tag<CleanupRowSelect[]>`
      SELECT ${cleanupColumns(tag, near)}
      FROM cleanups c
      JOIN users u ON u.id = c.organizer_user_id
      ${goingJoin(tag)}
      WHERE c.id = ${id}
      LIMIT 1
    `
    return rows[0] ? toRecord(rows[0]) : null
  }

  return {
    async createCleanupTx(args: CreateCleanupTxArgs): Promise<CleanupRecord> {
      return sql.begin(async (tx) => {
        const referenceCode = await allocateEventReferenceCode(tx, args.jurCode)

        await tx`
          INSERT INTO cleanups (
            id, organizer_user_id, type, event_kind, title, description, geom, scheduled_at, status,
            bring, address, jurisdiction_geoid, reference_code
          ) VALUES (
            ${args.cleanupId},
            ${args.organizerUserId},
            ${args.type},
            ${args.eventKind},
            ${args.title},
            ${args.description},
            ST_SetSRID(ST_MakePoint(${args.lng}, ${args.lat}), 4326),
            ${args.scheduledAt},
            ${args.status},
            ${args.bring as unknown as string[] | null},
            ${args.address},
            ${args.jurisdictionGeoid},
            ${referenceCode}
          )
        `
        await tx`
          INSERT INTO cleanup_members (cleanup_id, user_id, role)
          VALUES (${args.cleanupId}, ${args.organizerUserId}, 'organizer')
          ON CONFLICT (cleanup_id, user_id) DO NOTHING
        `
        await linkReportsInTx(tx, args.cleanupId, args.linkedReportIds, args.organizerUserId)

        const created = await readById(tx, args.cleanupId, null)
        if (!created) throw AppError.internal()
        return created
      })
    },

    async updateCleanup(id: string, patch: UpdateCleanupPatch): Promise<boolean> {
      const sets: postgres.Fragment[] = []
      if (patch.title !== undefined) sets.push(sql`title = ${patch.title}`)
      if (patch.description !== undefined) sets.push(sql`description = ${patch.description}`)
      if (patch.eventKind !== undefined) sets.push(sql`event_kind = ${patch.eventKind}`)
      if (patch.type !== undefined) sets.push(sql`type = ${patch.type}`)
      if (patch.scheduledAt !== undefined) sets.push(sql`scheduled_at = ${patch.scheduledAt}`)
      if (patch.lat !== undefined && patch.lng !== undefined) {
        sets.push(sql`geom = ST_SetSRID(ST_MakePoint(${patch.lng}, ${patch.lat}), 4326)`)
      }
      if (patch.address !== undefined) sets.push(sql`address = ${patch.address}`)
      if (patch.bring !== undefined) {
        sets.push(sql`bring = ${patch.bring as unknown as string[] | null}`)
      }

      if (sets.length === 0) {
        const rows = await sql<{ id: string }[]>`SELECT id FROM cleanups WHERE id = ${id} LIMIT 1`
        return rows.length > 0
      }
      const setList = sets.reduce((acc, frag, i) => (i === 0 ? frag : sql`${acc}, ${frag}`))
      const updated = await sql<{ id: string }[]>`
        UPDATE cleanups SET ${setList} WHERE id = ${id} RETURNING id
      `
      return updated.length > 0
    },

    async linkReports(
      cleanupId: string,
      reportIds: string[],
      actorId: string | null,
    ): Promise<string[]> {
      if (reportIds.length === 0) return []
      return sql.begin((tx) => linkReportsInTx(tx, cleanupId, reportIds, actorId))
    },

    async unlinkReport(
      cleanupId: string,
      reportId: string,
      actorId: string | null,
    ): Promise<boolean> {
      return sql.begin(async (tx) => {
        const removed = await tx<{ id: string }[]>`
          DELETE FROM cleanup_reports
          WHERE cleanup_id = ${cleanupId} AND report_id = ${reportId}
          RETURNING id
        `
        if (removed.length === 0) return false
        await tx`
          INSERT INTO cleanup_timeline (cleanup_id, kind, note, actor_id)
          VALUES (${cleanupId}, 'report_unlinked', ${`Unlinked report ${reportId}`}, ${actorId})
        `
        return true
      })
    },

    async reconcileLinkedReports(
      cleanupId: string,
      desiredIds: string[],
      actorId: string | null,
    ): Promise<{ added: string[]; removed: string[] }> {
      return sql.begin(async (tx) => {
        const existing = await tx<{ report_id: string }[]>`
          SELECT report_id FROM cleanup_reports WHERE cleanup_id = ${cleanupId}
        `
        const have = new Set(existing.map((r) => r.report_id))
        const want = new Set(desiredIds)
        const toAdd = desiredIds.filter((id) => !have.has(id))
        const toRemove = [...have].filter((id) => !want.has(id))

        const added = await linkReportsInTx(tx, cleanupId, toAdd, actorId)
        if (toRemove.length > 0) {
          await tx`
            DELETE FROM cleanup_reports
            WHERE cleanup_id = ${cleanupId} AND report_id = ANY(${toRemove}::uuid[])
          `
          await tx`
            INSERT INTO cleanup_timeline (cleanup_id, kind, note, actor_id)
            SELECT ${cleanupId}, 'report_unlinked', 'Unlinked report ' || rid, ${actorId}
            FROM unnest(${toRemove}::uuid[]) AS rid
          `
        }
        return { added, removed: toRemove }
      })
    },

    async loadLinkedReportsForCleanups(
      cleanupIds: string[],
    ): Promise<Map<string, LinkedReportView[]>> {
      const grouped = new Map<string, LinkedReportView[]>()
      if (cleanupIds.length === 0) return grouped
      const rows = await sql<
        {
          cleanup_id: string
          id: string
          category: ReportCategory
          type: ReportType
          title: string | null
          status: ReportStatus
          lng: number
          lat: number
          addr: string | null
          thumb_key: string | null
          linked_at: Date
        }[]
      >`
        SELECT
          cr.cleanup_id,
          r.id,
          r.category,
          r.type,
          r.title,
          r.status,
          ST_X(r.geom) AS lng,
          ST_Y(r.geom) AS lat,
          r.addr,
          m.thumb_key,
          cr.linked_at
        FROM cleanup_reports cr
        JOIN reports r ON r.id = cr.report_id
        LEFT JOIN LATERAL (
          SELECT COALESCE(ma.thumb_key, ma.r2_key) AS thumb_key
          FROM media_assets ma
          WHERE ma.report_id = r.id AND ma.status = 'ready'
          ORDER BY ma.created_at ASC
          LIMIT 1
        ) m ON true
        WHERE cr.cleanup_id = ANY(${cleanupIds}::uuid[])
          AND r.deleted_at IS NULL
          AND r.status = 'published'
          AND r.visibility = 'public'
        ORDER BY cr.cleanup_id, cr.linked_at DESC, r.id
      `
      for (const r of rows) {
        const view: LinkedReportView = {
          cleanupId: r.cleanup_id,
          id: r.id,
          category: r.category,
          type: r.type,
          title: r.title,
          status: r.status,
          lat: r.lat,
          lng: r.lng,
          addr: r.addr,
          thumbKey: r.thumb_key,
          linkedAt: r.linked_at,
        }
        const list = grouped.get(r.cleanup_id)
        if (list) list.push(view)
        else grouped.set(r.cleanup_id, [view])
      }
      return grouped
    },

    async loadLinkedEventsForReports(
      reportIds: string[],
    ): Promise<Map<string, LinkedEventView[]>> {
      const grouped = new Map<string, LinkedEventView[]>()
      if (reportIds.length === 0) return grouped
      const rows = await sql<
        {
          report_id: string
          id: string
          title: string
          event_kind: EventKind
          status: CleanupStatus
          scheduled_at: Date
          lng: number
          lat: number
          going: number
          org_id: string
          org_display_name: string
          org_handle: string | null
          org_bio: string | null
          linked_at: Date
        }[]
      >`
        SELECT
          cr.report_id,
          c.id,
          c.title,
          c.event_kind,
          c.status,
          c.scheduled_at,
          ST_X(c.geom) AS lng,
          ST_Y(c.geom) AS lat,
          COALESCE(g.going, 0) AS going,
          u.id AS org_id,
          u.display_name AS org_display_name,
          u.handle AS org_handle,
          u.bio AS org_bio,
          cr.linked_at
        FROM cleanup_reports cr
        JOIN cleanups c ON c.id = cr.cleanup_id
        JOIN users u ON u.id = c.organizer_user_id
        LEFT JOIN LATERAL (
          SELECT count(*)::int AS going FROM cleanup_members m WHERE m.cleanup_id = c.id
        ) g ON true
        WHERE cr.report_id = ANY(${reportIds}::uuid[])
        ORDER BY cr.report_id, cr.linked_at DESC, c.id
      `
      for (const r of rows) {
        const view: LinkedEventView = {
          reportId: r.report_id,
          id: r.id,
          title: r.title,
          eventKind: r.event_kind,
          status: r.status,
          scheduledAt: r.scheduled_at,
          lat: r.lat,
          lng: r.lng,
          going: r.going,
          organizer: {
            id: r.org_id,
            displayName: r.org_display_name,
            handle: r.org_handle,
            bio: r.org_bio,
          },
          linkedAt: r.linked_at,
        }
        const list = grouped.get(r.report_id)
        if (list) list.push(view)
        else grouped.set(r.report_id, [view])
      }
      return grouped
    },

    async filterVisibleReportIds(reportIds: string[]): Promise<Set<string>> {
      if (reportIds.length === 0) return new Set()
      const rows = await sql<{ id: string }[]>`
        SELECT id FROM reports
        WHERE id = ANY(${reportIds}::uuid[])
          AND deleted_at IS NULL
          AND status = 'published'
          AND visibility = 'public'
      `
      return new Set(rows.map((r) => r.id))
    },

    async findCleanupById(id: string, near: NearPoint | null): Promise<CleanupRecord | null> {
      return readById(sql, id, near)
    },

    async findCleanupByReferenceCode(code: string): Promise<CleanupRecord | null> {
      const rows = await sql<CleanupRowSelect[]>`
        SELECT ${cleanupColumns(sql, null)}
        FROM cleanups c
        JOIN users u ON u.id = c.organizer_user_id
        ${goingJoin(sql)}
        WHERE c.reference_code = ${code}
        LIMIT 1
      `
      return rows[0] ? toRecord(rows[0]) : null
    },

    async listCleanups(
      filters: ListCleanupsFilters,
    ): Promise<{ records: CleanupRecord[]; nextCursor: string | null }> {
      const near = filters.near ?? null
      const whenFilter = buildWhenFilter(sql, filters.when)
      const bboxFilter = buildBboxFilter(sql, filters.bbox)
      const membershipFilter = buildMembershipFilter(sql, filters.when, filters.viewerId)

      if (near !== null) {
        const point = sql`ST_SetSRID(ST_MakePoint(${near.lng}, ${near.lat}), 4326)`
        const cursor = parseNearCursor(filters.cursor)
        const cursorFilter =
          cursor !== null
            ? sql`AND (c.geom <-> ${point}, c.id) > (${cursor.dist}::float8, ${cursor.id}::uuid)`
            : sql``
        const rows = await sql<CleanupRowSelect[]>`
          SELECT ${cleanupColumns(sql, near)}, (c.geom <-> ${point}) AS knn
          FROM cleanups c
          JOIN users u ON u.id = c.organizer_user_id
          ${goingJoin(sql)}
          WHERE TRUE
            ${whenFilter}
            ${membershipFilter}
            ${bboxFilter}
            ${cursorFilter}
          ORDER BY c.geom <-> ${point} ASC, c.id ASC
          LIMIT ${filters.limit + 1}
        `
        return paginate(rows, filters.limit, (last) =>
          last.knn === null || last.knn === undefined ? null : `${Number(last.knn)}|${last.id}`,
        )
      }

      const past = filters.when === "past"
      const cursor = parseTimeCursor(filters.cursor)
      const cursorFilter =
        cursor !== null
          ? past
            ? sql`AND (c.scheduled_at, c.id) < (${cursor.at}, ${cursor.id}::uuid)`
            : sql`AND (c.scheduled_at, c.id) > (${cursor.at}, ${cursor.id}::uuid)`
          : sql``
      const order = past
        ? sql`ORDER BY c.scheduled_at DESC, c.id DESC`
        : sql`ORDER BY c.scheduled_at ASC, c.id ASC`
      const rows = await sql<CleanupRowSelect[]>`
        SELECT ${cleanupColumns(sql, null)}
        FROM cleanups c
        JOIN users u ON u.id = c.organizer_user_id
        ${goingJoin(sql)}
        WHERE TRUE
          ${whenFilter}
          ${membershipFilter}
          ${bboxFilter}
          ${cursorFilter}
        ${order}
        LIMIT ${filters.limit + 1}
      `
      return paginate(rows, filters.limit, (last) => `${last.scheduled_at.toISOString()}|${last.id}`)
    },

    async isMember(cleanupId: string, userId: string): Promise<boolean> {
      const rows = await sql<{ one: number }[]>`
        SELECT 1 AS one FROM cleanup_members
        WHERE cleanup_id = ${cleanupId} AND user_id = ${userId}
        LIMIT 1
      `
      return rows.length > 0
    },

    async roleOf(cleanupId: string, userId: string): Promise<"organizer" | "member" | null> {
      const rows = await sql<{ role: "organizer" | "member" }[]>`
        SELECT role FROM cleanup_members
        WHERE cleanup_id = ${cleanupId} AND user_id = ${userId}
        LIMIT 1
      `
      return rows[0]?.role ?? null
    },

    async membersOf(cleanupIds: string[], userId: string): Promise<Set<string>> {
      if (cleanupIds.length === 0) return new Set()
      const rows = await sql<{ cleanup_id: string }[]>`
        SELECT cleanup_id FROM cleanup_members
        WHERE user_id = ${userId} AND cleanup_id = ANY(${cleanupIds}::uuid[])
      `
      return new Set(rows.map((r) => r.cleanup_id))
    },

    async listMemberIds(cleanupId: string, limit: number): Promise<string[]> {
      const rows = await sql<{ user_id: string }[]>`
        SELECT user_id FROM cleanup_members
        WHERE cleanup_id = ${cleanupId}
        ORDER BY joined_at ASC, user_id ASC
        LIMIT ${limit}
      `
      return rows.map((r) => r.user_id)
    },

    async memberCount(cleanupId: string): Promise<number> {
      const rows = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM cleanup_members WHERE cleanup_id = ${cleanupId}
      `
      return rows[0]?.count ?? 0
    },

    async organizerOf(cleanupId: string): Promise<string | null> {
      const rows = await sql<{ organizer_user_id: string }[]>`
        SELECT organizer_user_id FROM cleanups WHERE id = ${cleanupId} LIMIT 1
      `
      return rows[0]?.organizer_user_id ?? null
    },

    async joinCleanupTx(cleanupId: string, userId: string): Promise<boolean> {
      return sql.begin(async (tx) => {
        const exists = await tx<{ one: number }[]>`
          SELECT 1 AS one FROM cleanups WHERE id = ${cleanupId} LIMIT 1
        `
        if (exists.length === 0) return false
        await tx`
          INSERT INTO cleanup_members (cleanup_id, user_id, role)
          VALUES (${cleanupId}, ${userId}, 'member')
          ON CONFLICT (cleanup_id, user_id) DO NOTHING
        `
        return true
      })
    },

    async leaveCleanup(cleanupId: string, userId: string): Promise<boolean> {
      const exists = await sql<{ one: number }[]>`
        SELECT 1 AS one FROM cleanups WHERE id = ${cleanupId} LIMIT 1
      `
      if (exists.length === 0) return false
      await sql`
        DELETE FROM cleanup_members WHERE cleanup_id = ${cleanupId} AND user_id = ${userId}
      `
      return true
    },

    async cancelCleanupTx(
      id: string,
      input: { note: string; body: string; reason: string | null; actorId: string },
    ): Promise<boolean> {
      return sql.begin(async (tx) => {
        const updated = await tx<{ id: string }[]>`
          UPDATE cleanups SET status = 'cancelled'
          WHERE id = ${id} AND status <> 'cancelled'
          RETURNING id
        `
        if (updated.length === 0) {
          const existing = await tx<{ id: string }[]>`
            SELECT id FROM cleanups WHERE id = ${id} LIMIT 1
          `
          return existing.length > 0
        }
        await tx`
          INSERT INTO cleanup_timeline (cleanup_id, kind, note, actor_id)
          VALUES (${id}, 'cancel', ${input.note}, ${input.actorId})
        `
        await tx`
          INSERT INTO notifications (user_id, type, title, body, link)
          SELECT cm.user_id, 'cleanup_cancelled', 'Event cancelled', ${input.body}, ${`/cleanups/${id}`}
          FROM cleanup_members cm
          WHERE cm.cleanup_id = ${id} AND cm.user_id <> ${input.actorId}
        `
        return true
      })
    },

    async listAttendees(args: ListAttendeesArgs): Promise<AttendeeView[]> {
      const { cleanupId, viewerId, onlyFollowed, limit } = args
      const followingExpr =
        viewerId !== null
          ? sql`EXISTS (SELECT 1 FROM follows_people f WHERE f.follower_id = ${viewerId} AND f.followee_id = u.id)`
          : sql`FALSE`
      const onlyFollowedFilter = onlyFollowed
        ? viewerId !== null
          ? sql`AND EXISTS (SELECT 1 FROM follows_people f2 WHERE f2.follower_id = ${viewerId} AND f2.followee_id = u.id)`
          : sql`AND FALSE`
        : sql``
      const rows = await sql<AttendeeRowSelect[]>`
        SELECT
          u.id,
          u.display_name,
          u.handle,
          u.bio,
          ${followingExpr} AS is_following
        FROM cleanup_members m
        JOIN users u ON u.id = m.user_id
        WHERE m.cleanup_id = ${cleanupId}
          AND u.deleted_at IS NULL
          ${onlyFollowedFilter}
        ORDER BY (m.role = 'organizer') DESC, m.joined_at ASC, u.id ASC
        LIMIT ${limit}
      `
      return rows.map((r) => ({
        id: r.id,
        displayName: r.display_name,
        handle: r.handle,
        bio: r.bio,
        isFollowing: r.is_following,
      }))
    },

    async resolveJurisdictionContact(
      geoid: string | null,
    ): Promise<{ contact: string; name: string } | null> {
      if (geoid === null) return null
      const rows = await sql<{ name: string | null; default_email: string | null; legacy_email: string | null }[]>`
        SELECT
          j.name,
          (SELECT jc.email FROM jurisdiction_contacts jc
             WHERE jc.geoid = j.geoid AND jc.category IS NULL
               AND jc.email IS NOT NULL AND jc.email <> '' LIMIT 1) AS default_email,
          j.contact_emails[1] AS legacy_email
        FROM jurisdictions j
        WHERE j.geoid = ${geoid}
        LIMIT 1
      `
      const row = rows[0]
      if (!row) return null
      const contact = row.default_email ?? row.legacy_email ?? null
      if (contact === null || contact === "") return null
      return { contact, name: row.name ?? geoid }
    },

    async appendCleanupTimeline(
      cleanupId: string,
      input: { kind: string; note: string | null; actorId: string | null },
    ): Promise<void> {
      await sql`
        INSERT INTO cleanup_timeline (cleanup_id, kind, note, actor_id)
        VALUES (${cleanupId}, ${input.kind}, ${input.note}, ${input.actorId})
      `
    },
  }
}

async function linkReportsInTx(
  tx: Queryable,
  cleanupId: string,
  reportIds: string[],
  actorId: string | null,
): Promise<string[]> {
  if (reportIds.length === 0) return []
  const inserted = await tx<{ report_id: string }[]>`
    INSERT INTO cleanup_reports (cleanup_id, report_id, linked_by_user_id)
    SELECT ${cleanupId}, rid, ${actorId}
    FROM unnest(${reportIds}::uuid[]) AS rid
    ON CONFLICT (cleanup_id, report_id) DO NOTHING
    RETURNING report_id
  `
  const newlyLinked = inserted.map((r) => r.report_id)
  if (newlyLinked.length > 0) {
    await tx`
      INSERT INTO cleanup_timeline (cleanup_id, kind, note, actor_id)
      SELECT ${cleanupId}, 'report_linked', 'Linked report ' || rid, ${actorId}
      FROM unnest(${newlyLinked}::uuid[]) AS rid
    `
  }
  return newlyLinked
}

function paginate(
  rows: CleanupRowSelect[],
  limit: number,
  cursorOf: (last: CleanupRowSelect) => string | null,
): { records: CleanupRecord[]; nextCursor: string | null } {
  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  const last = page[page.length - 1]
  const nextCursor = hasMore && last ? cursorOf(last) : null
  return { records: page.map(toRecord), nextCursor }
}
