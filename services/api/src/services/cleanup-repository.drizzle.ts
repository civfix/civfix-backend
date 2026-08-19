
import { AppError, MAX_LINKED_REPORTS } from "@civfix/shared"
import type postgres from "postgres"
import type { Queryable, Sql } from "../db/client.js"
import {
  encodeNearCursor,
  encodeTimeCursor,
  pageWith,
  parseNearCursor,
  parseTimeCursor,
} from "../db/cursor-helpers.js"
import { allocateEventReferenceCode } from "../db/reference-code.js"
import { firstReadyStillLateral, publicReportFilter } from "./report-sql.js"
import type {
  AttendeeView,
  CancelCleanupOutcome,
  ClaimSlotOutcome,
  CleanupRecord,
  CleanupRepository,
  CompleteCleanupOutcome,
  CreateCleanupTxArgs,
  DesiredSlot,
  EventSlotView,
  LinkedEventView,
  LinkedReportView,
  ListAttendeesArgs,
  LeaveCleanupOutcome,
  ListCleanupsFilters,
  NearPoint,
  RemoveMemberOutcome,
  SlotReconcileResult,
  UpdateCleanupPatch,
} from "./cleanup-repository.types.js"
import { isCleanupTerminal } from "./cleanup-rules.js"
import { blockedPairExpr, hiddenIdentity } from "./hidden-identity.js"
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
  CleanupMemberRole,
  CleanupStatus,
  EventKind,
  ReportCategory,
  ReportStatus,
  ReportType,
} from "@civfix/shared"

const PG_UNIQUE_VIOLATION = "23505"

export const LINKED_EVENTS_PER_REPORT_CAP = 20
export const MAX_EVENTS_PER_REPORT = 50

const SLOT_TITLE_INDEX = "cleanup_slots_cleanup_title_uidx"

function isSlotTitleConflict(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false
  const e = err as { code?: unknown; constraint_name?: unknown; detail?: unknown }
  if (e.code !== PG_UNIQUE_VIOLATION) return false
  const constraint = typeof e.constraint_name === "string" ? e.constraint_name : ""
  const detail = typeof e.detail === "string" ? e.detail : ""
  return constraint === SLOT_TITLE_INDEX || detail.includes("lower(title)")
}

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
        await insertSlotsInTx(tx, args.cleanupId, args.slots)

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
      if (patch.jurisdictionGeoid !== undefined) {
        sets.push(sql`jurisdiction_geoid = ${patch.jurisdictionGeoid}`)
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
      perCleanupCap: number = MAX_LINKED_REPORTS,
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
          cleanup_id, id, category, type, title, status, lng, lat, addr, thumb_key, linked_at
        FROM (
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
            COALESCE(m.thumb_key, m.r2_key) AS thumb_key,
            cr.linked_at,
            row_number() OVER (
              PARTITION BY cr.cleanup_id ORDER BY cr.linked_at DESC, r.id
            ) AS rn
          FROM cleanup_reports cr
          JOIN reports r ON r.id = cr.report_id
          ${firstReadyStillLateral(sql)}
          WHERE cr.cleanup_id = ANY(${cleanupIds}::uuid[])
            AND ${publicReportFilter(sql)}
        ) ranked
        WHERE rn <= ${perCleanupCap}
        ORDER BY cleanup_id, linked_at DESC, id
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
          report_id, id, title, event_kind, status, scheduled_at,
          lng, lat, going, org_id, org_display_name, org_handle, org_bio, linked_at
        FROM (
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
            cr.linked_at,
            row_number() OVER (
              PARTITION BY cr.report_id ORDER BY cr.linked_at DESC, c.id
            ) AS rn
          FROM cleanup_reports cr
          JOIN cleanups c ON c.id = cr.cleanup_id
          JOIN users u ON u.id = c.organizer_user_id
          LEFT JOIN LATERAL (
            SELECT count(*)::int AS going FROM cleanup_members m WHERE m.cleanup_id = c.id
          ) g ON true
          WHERE cr.report_id = ANY(${reportIds}::uuid[])
        ) ranked
        WHERE rn <= ${LINKED_EVENTS_PER_REPORT_CAP}
        ORDER BY report_id, linked_at DESC, id
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
        SELECT r.id FROM reports r
        WHERE r.id = ANY(${reportIds}::uuid[])
          AND ${publicReportFilter(sql)}
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
          last.knn === null || last.knn === undefined
            ? null
            : encodeNearCursor({ dist: Number(last.knn), id: last.id }),
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
      return paginate(rows, filters.limit, (last) =>
        encodeTimeCursor({ at: last.scheduled_at, id: last.id }),
      )
    },

    async isMember(cleanupId: string, userId: string): Promise<boolean> {
      const rows = await sql<{ one: number }[]>`
        SELECT 1 AS one FROM cleanup_members
        WHERE cleanup_id = ${cleanupId} AND user_id = ${userId}
        LIMIT 1
      `
      return rows.length > 0
    },

    async roleOf(cleanupId: string, userId: string): Promise<CleanupMemberRole | null> {
      const rows = await sql<{ role: CleanupMemberRole }[]>`
        SELECT role FROM cleanup_members
        WHERE cleanup_id = ${cleanupId} AND user_id = ${userId}
        LIMIT 1
      `
      return rows[0]?.role ?? null
    },

    async rolesOf(cleanupIds: string[], userId: string): Promise<Map<string, CleanupMemberRole>> {
      if (cleanupIds.length === 0) return new Map()
      const rows = await sql<{ cleanup_id: string; role: CleanupMemberRole }[]>`
        SELECT cleanup_id, role FROM cleanup_members
        WHERE user_id = ${userId} AND cleanup_id = ANY(${cleanupIds}::uuid[])
      `
      return new Map(rows.map((r) => [r.cleanup_id, r.role]))
    },

    async setMemberRole(
      cleanupId: string,
      userId: string,
      role: "cohost" | "member",
    ): Promise<boolean> {
      const rows = await sql<{ user_id: string }[]>`
        UPDATE cleanup_members SET role = ${role}
        WHERE cleanup_id = ${cleanupId} AND user_id = ${userId} AND role <> 'organizer'
        RETURNING user_id
      `
      return rows.length > 0
    },

    async removeMember(
      cleanupId: string,
      userId: string,
      actorId: string,
    ): Promise<RemoveMemberOutcome> {
      return sql.begin(async (tx) => {
        const locked = await tx<{ status: CleanupStatus }[]>`
          SELECT status FROM cleanups WHERE id = ${cleanupId} LIMIT 1 FOR NO KEY UPDATE
        `
        const cleanup = locked[0]
        if (cleanup === undefined) return { kind: "not_found" }
        if (isCleanupTerminal(cleanup.status)) return { kind: "closed" }
        const deleted = await tx<{ user_id: string }[]>`
          DELETE FROM cleanup_members
          WHERE cleanup_id = ${cleanupId} AND user_id = ${userId} AND role <> 'organizer'
          RETURNING user_id
        `
        if (deleted.length > 0) {
          await tx`
            INSERT INTO cleanup_bans (cleanup_id, user_id, banned_by_user_id)
            VALUES (${cleanupId}, ${userId}, ${actorId})
            ON CONFLICT (cleanup_id, user_id) DO NOTHING
          `
          await tx`
            DELETE FROM cleanup_slot_claims
            WHERE cleanup_id = ${cleanupId} AND user_id = ${userId}
          `
        }
        const counted = await tx<{ count: number }[]>`
          SELECT count(*)::int AS count FROM cleanup_members WHERE cleanup_id = ${cleanupId}
        `
        const going = counted[0]?.count ?? 0
        return deleted.length > 0 ? { kind: "removed", going } : { kind: "not_member", going }
      })
    },

    async isBanned(cleanupId: string, userId: string): Promise<boolean> {
      const rows = await sql<{ one: number }[]>`
        SELECT 1 AS one FROM cleanup_bans
        WHERE cleanup_id = ${cleanupId} AND user_id = ${userId}
        LIMIT 1
      `
      return rows.length > 0
    },

    async unbanMember(cleanupId: string, userId: string): Promise<boolean> {
      const rows = await sql<{ user_id: string }[]>`
        DELETE FROM cleanup_bans
        WHERE cleanup_id = ${cleanupId} AND user_id = ${userId}
        RETURNING user_id
      `
      return rows.length > 0
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

    async joinCleanupTx(
      cleanupId: string,
      userId: string,
    ): Promise<"joined" | "not_found" | "banned" | "closed"> {
      return sql.begin(async (tx) => {
        const locked = await tx<{ status: CleanupStatus }[]>`
          SELECT status FROM cleanups WHERE id = ${cleanupId} LIMIT 1 FOR SHARE
        `
        const cleanup = locked[0]
        if (cleanup === undefined) return "not_found"
        if (isCleanupTerminal(cleanup.status)) return "closed"
        const banned = await tx<{ one: number }[]>`
          SELECT 1 AS one FROM cleanup_bans
          WHERE cleanup_id = ${cleanupId} AND user_id = ${userId}
          LIMIT 1
        `
        if (banned.length > 0) return "banned"
        await tx`
          INSERT INTO cleanup_members (cleanup_id, user_id, role)
          VALUES (${cleanupId}, ${userId}, 'member')
          ON CONFLICT (cleanup_id, user_id) DO NOTHING
        `
        return "joined"
      })
    },

    async leaveCleanup(cleanupId: string, userId: string): Promise<LeaveCleanupOutcome> {
      return sql.begin(async (tx) => {
        const locked = await tx<{ status: CleanupStatus }[]>`
          SELECT status FROM cleanups WHERE id = ${cleanupId} LIMIT 1 FOR SHARE
        `
        const cleanup = locked[0]
        if (cleanup === undefined) return "not_found"
        if (isCleanupTerminal(cleanup.status)) return "closed"
        await tx`
          DELETE FROM cleanup_members WHERE cleanup_id = ${cleanupId} AND user_id = ${userId}
        `
        await tx`
          DELETE FROM cleanup_slot_claims WHERE cleanup_id = ${cleanupId} AND user_id = ${userId}
        `
        return "left"
      })
    },

    async cancelCleanupTx(
      id: string,
      input: { note: string; body: string; reason: string | null; actorId: string },
    ): Promise<CancelCleanupOutcome> {
      return sql.begin(async (tx) => {
        const updated = await tx<{ id: string }[]>`
          UPDATE cleanups SET status = 'cancelled'
          WHERE id = ${id} AND status <> 'cancelled' AND status <> 'done'
          RETURNING id
        `
        if (updated.length === 0) {
          const existing = await tx<{ status: CleanupStatus }[]>`
            SELECT status FROM cleanups WHERE id = ${id} LIMIT 1
          `
          const status = existing[0]?.status
          if (status === undefined) return "not_found"
          return status === "done" ? "already_completed" : "already_cancelled"
        }
        await tx`
          INSERT INTO cleanup_timeline (cleanup_id, kind, note, actor_id)
          VALUES (${id}, 'cancel', ${input.note}, ${input.actorId})
        `
        return "cancelled"
      })
    },

    async completeCleanupTx(
      id: string,
      input: { note: string; actorId: string; now: Date },
    ): Promise<CompleteCleanupOutcome> {
      return sql.begin(async (tx) => {
        const locked = await tx<{ status: CleanupStatus; scheduled_at: Date }[]>`
          SELECT status, scheduled_at FROM cleanups WHERE id = ${id} LIMIT 1 FOR NO KEY UPDATE
        `
        const row = locked[0]
        if (row === undefined) return "not_found"
        if (row.status === "cancelled") return "cancelled"
        if (row.status === "done") return "already_completed"
        if (row.scheduled_at.getTime() > input.now.getTime()) return "too_early"
        await tx`UPDATE cleanups SET status = 'done' WHERE id = ${id}`
        await tx`
          INSERT INTO cleanup_timeline (cleanup_id, kind, note, actor_id)
          VALUES (${id}, 'status', ${input.note}, ${input.actorId})
        `
        return "completed"
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
      const blockedPair = blockedPairExpr(sql, viewerId, sql`u.id`)
      const rows = await sql<
        (AttendeeRowSelect & {
          slot_id: string | null
          slot_title: string | null
          blocked_pair: boolean
        })[]
      >`
        SELECT
          u.id,
          u.display_name,
          u.handle,
          u.bio,
          m.role,
          ${followingExpr} AS is_following,
          ${blockedPair} AS blocked_pair,
          cs.id AS slot_id,
          cs.title AS slot_title
        FROM cleanup_members m
        JOIN users u ON u.id = m.user_id
        LEFT JOIN cleanup_slot_claims csc
          ON csc.cleanup_id = m.cleanup_id AND csc.user_id = m.user_id
        LEFT JOIN cleanup_slots cs ON cs.id = csc.slot_id
        WHERE m.cleanup_id = ${cleanupId}
          AND u.deleted_at IS NULL
          ${onlyFollowedFilter}
        ORDER BY (m.role = 'organizer') DESC, (m.role = 'cohost') DESC, m.joined_at ASC, u.id ASC
        LIMIT ${limit}
      `
      return rows.map((r) => {
        const hidden = r.blocked_pair ? hiddenIdentity(r.id) : null
        return {
          id: r.id,
          displayName: hidden?.name ?? r.display_name,
          handle: hidden !== null ? null : r.handle,
          bio: hidden !== null ? null : r.bio,
          role: r.role,
          isFollowing: r.is_following,
          slot:
            r.slot_id !== null && r.slot_title !== null
              ? { id: r.slot_id, title: r.slot_title }
              : null,
        }
      })
    },

    async listSlots(cleanupId: string, viewerId: string | null): Promise<EventSlotView[]> {
      const grouped = await loadSlots(sql, [cleanupId], viewerId)
      return grouped.get(cleanupId) ?? []
    },

    async loadSlotsForCleanups(
      cleanupIds: string[],
      viewerId: string | null,
    ): Promise<Map<string, EventSlotView[]>> {
      return loadSlots(sql, cleanupIds, viewerId)
    },

    async slotCountsFor(cleanupIds: string[]): Promise<Map<string, number>> {
      if (cleanupIds.length === 0) return new Map()
      const rows = await sql<{ cleanup_id: string; n: number }[]>`
        SELECT cleanup_id, count(*)::int AS n
        FROM cleanup_slots
        WHERE cleanup_id = ANY(${cleanupIds}::uuid[])
        GROUP BY cleanup_id
      `
      return new Map(rows.map((r) => [r.cleanup_id, r.n]))
    },

    async reconcileSlots(
      cleanupId: string,
      desired: DesiredSlot[],
      actorId: string | null,
    ): Promise<SlotReconcileResult> {
      try {
        return await sql.begin(async (tx) => {
          const existing = await tx<{ id: string; title: string }[]>`
            SELECT id, title FROM cleanup_slots WHERE cleanup_id = ${cleanupId}
          `
          const have = new Map(existing.map((r) => [r.id, r.title]))

          for (const slot of desired) {
            if (slot.id !== undefined && !have.has(slot.id)) {
              throw AppError.validation({ slots: `unknown slot: ${slot.id}` })
            }
          }


          const keep = new Set(desired.map((s) => s.id).filter((id): id is string => id !== undefined))
          const toRemove = [...have.keys()].filter((id) => !keep.has(id))
          const removed: SlotReconcileResult["removed"] = []
          if (toRemove.length > 0) {
            const claimants = await tx<{ slot_id: string; user_id: string }[]>`
              SELECT slot_id, user_id FROM cleanup_slot_claims
              WHERE cleanup_id = ${cleanupId} AND slot_id = ANY(${toRemove}::uuid[])
            `
            const bySlot = new Map<string, string[]>()
            for (const c of claimants) {
              const list = bySlot.get(c.slot_id)
              if (list) list.push(c.user_id)
              else bySlot.set(c.slot_id, [c.user_id])
            }
            await tx`
              DELETE FROM cleanup_slots
              WHERE cleanup_id = ${cleanupId} AND id = ANY(${toRemove}::uuid[])
            `
            for (const slotId of toRemove) {
              removed.push({
                slotId,
                title: have.get(slotId) ?? "",
                claimantUserIds: (bySlot.get(slotId) ?? []).filter((u) => u !== actorId),
              })
            }
          }

          const renaming = desired
            .filter((s): s is DesiredSlot & { id: string } => s.id !== undefined)
            .filter((s) => have.get(s.id) !== s.title)
            .map((s) => s.id)
          if (renaming.length > 0) {
            await tx`
              UPDATE cleanup_slots SET title = id::text
              WHERE cleanup_id = ${cleanupId} AND id = ANY(${renaming}::uuid[])
            `
          }

          const added: string[] = []
          const updated: string[] = []
          for (const slot of desired) {
            if (slot.id !== undefined) {
              await tx`
                UPDATE cleanup_slots SET
                  title = ${slot.title},
                  description = ${slot.description},
                  capacity = ${slot.capacity},
                  sort_order = ${slot.sortOrder}
                WHERE id = ${slot.id} AND cleanup_id = ${cleanupId}
              `
              updated.push(slot.id)
            } else {
              const [row] = await tx<{ id: string }[]>`
                INSERT INTO cleanup_slots (cleanup_id, title, description, capacity, sort_order)
                VALUES (${cleanupId}, ${slot.title}, ${slot.description}, ${slot.capacity}, ${slot.sortOrder})
                RETURNING id
              `
              if (row) added.push(row.id)
            }
          }
          return { added, updated, removed }
        })
      } catch (err) {
        if (isSlotTitleConflict(err)) {
          throw AppError.validation({ slots: "duplicate slot title" })
        }
        throw err
      }
    },

    async claimSlot(
      cleanupId: string,
      userId: string,
      slotId: string,
    ): Promise<ClaimSlotOutcome> {
      return sql.begin(async (tx) => {
        const locked = await tx<{ status: CleanupStatus }[]>`
          SELECT status FROM cleanups WHERE id = ${cleanupId} LIMIT 1 FOR SHARE
        `
        const cleanup = locked[0]
        if (cleanup === undefined) return { kind: "not_found" }
        if (isCleanupTerminal(cleanup.status)) return { kind: "closed" }

        const banned = await tx<{ one: number }[]>`
          SELECT 1 AS one FROM cleanup_bans
          WHERE cleanup_id = ${cleanupId} AND user_id = ${userId}
          LIMIT 1
        `
        if (banned.length > 0) return { kind: "banned" }

        const mine = await tx<{ slot_id: string }[]>`
          SELECT slot_id FROM cleanup_slot_claims
          WHERE cleanup_id = ${cleanupId} AND user_id = ${userId}
          LIMIT 1
        `
        const currentSlotId = mine[0]?.slot_id ?? null

        const slotRows = await tx<{ capacity: number | null }[]>`
          SELECT capacity FROM cleanup_slots
          WHERE id = ${slotId} AND cleanup_id = ${cleanupId}
          LIMIT 1
          FOR UPDATE
        `
        const slot = slotRows[0]
        if (slot === undefined) return { kind: "slot_not_found" }

        if (currentSlotId === slotId) return { kind: "claimed", slotId }

        if (slot.capacity !== null) {
          const counted = await tx<{ n: number }[]>`
            SELECT count(*)::int AS n FROM cleanup_slot_claims WHERE slot_id = ${slotId}
          `
          if ((counted[0]?.n ?? 0) >= slot.capacity) return { kind: "full" }
        }

        await tx`
          INSERT INTO cleanup_members (cleanup_id, user_id, role)
          VALUES (${cleanupId}, ${userId}, 'member')
          ON CONFLICT (cleanup_id, user_id) DO NOTHING
        `

        await tx`
          INSERT INTO cleanup_slot_claims (cleanup_id, user_id, slot_id)
          VALUES (${cleanupId}, ${userId}, ${slotId})
          ON CONFLICT (cleanup_id, user_id)
          DO UPDATE SET slot_id = EXCLUDED.slot_id, claimed_at = now()
        `
        return { kind: "claimed", slotId }
      })
    },

    async releaseSlot(cleanupId: string, userId: string): Promise<ClaimSlotOutcome> {
      const rows = await sql<{ status: CleanupStatus }[]>`
        SELECT status FROM cleanups WHERE id = ${cleanupId} LIMIT 1
      `
      const status = rows[0]?.status
      if (status === undefined) return { kind: "not_found" }
      if (isCleanupTerminal(status)) return { kind: "closed" }
      await sql`
        DELETE FROM cleanup_slot_claims WHERE cleanup_id = ${cleanupId} AND user_id = ${userId}
      `
      return { kind: "released" }
    },

    async slotOf(cleanupId: string, userId: string): Promise<string | null> {
      const rows = await sql<{ slot_id: string }[]>`
        SELECT slot_id FROM cleanup_slot_claims
        WHERE cleanup_id = ${cleanupId} AND user_id = ${userId}
        LIMIT 1
      `
      return rows[0]?.slot_id ?? null
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
  const overCap = await tx<{ report_id: string }[]>`
    SELECT cr.report_id
    FROM cleanup_reports cr
    WHERE cr.report_id = ANY(${reportIds}::uuid[])
      AND cr.cleanup_id <> ${cleanupId}
    GROUP BY cr.report_id
    HAVING count(*) >= ${MAX_EVENTS_PER_REPORT}
  `
  if (overCap.length > 0) {
    throw AppError.validation({
      linkedReportIds: `already linked to the maximum number of events: ${overCap
        .map((r) => r.report_id)
        .join(", ")}`,
    })
  }
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

async function insertSlotsInTx(
  tx: Queryable,
  cleanupId: string,
  slots: DesiredSlot[],
): Promise<void> {
  if (slots.length === 0) return
  for (const slot of slots) {
    await tx`
      INSERT INTO cleanup_slots (cleanup_id, title, description, capacity, sort_order)
      VALUES (${cleanupId}, ${slot.title}, ${slot.description}, ${slot.capacity}, ${slot.sortOrder})
    `
  }
}

async function loadSlots(
  tag: Sql,
  cleanupIds: string[],
  viewerId: string | null,
): Promise<Map<string, EventSlotView[]>> {
  const grouped = new Map<string, EventSlotView[]>()
  if (cleanupIds.length === 0) return grouped
  const rows = await tag<
    {
      cleanup_id: string
      id: string
      title: string
      description: string | null
      capacity: number | null
      sort_order: number
      claimed: number
      mine: boolean
    }[]
  >`
    SELECT s.cleanup_id, s.id, s.title, s.description, s.capacity, s.sort_order,
           COALESCE(c.n, 0)::int AS claimed,
           (mine.user_id IS NOT NULL) AS mine
    FROM cleanup_slots s
    LEFT JOIN (
      SELECT cl.slot_id, count(*) AS n
      FROM cleanup_slot_claims cl
      WHERE cl.cleanup_id = ANY(${cleanupIds}::uuid[])
      GROUP BY cl.slot_id
    ) c ON c.slot_id = s.id
    LEFT JOIN cleanup_slot_claims mine
      ON mine.slot_id = s.id AND mine.user_id = ${viewerId}
    WHERE s.cleanup_id = ANY(${cleanupIds}::uuid[])
    ORDER BY s.cleanup_id, s.sort_order, s.id
  `
  for (const r of rows) {
    const view: EventSlotView = {
      cleanupId: r.cleanup_id,
      id: r.id,
      title: r.title,
      description: r.description,
      capacity: r.capacity,
      sortOrder: r.sort_order,
      claimed: r.claimed,
      mine: r.mine,
    }
    const list = grouped.get(r.cleanup_id)
    if (list) list.push(view)
    else grouped.set(r.cleanup_id, [view])
  }
  return grouped
}

function paginate(
  rows: CleanupRowSelect[],
  limit: number,
  cursorOf: (last: CleanupRowSelect) => string | null,
): { records: CleanupRecord[]; nextCursor: string | null } {
  const { items, nextCursor } = pageWith(rows, limit, cursorOf)
  return { records: items.map(toRecord), nextCursor }
}
