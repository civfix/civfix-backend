
import { AppError } from "@civfix/shared"
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
// THE canonical "this report is publicly readable" predicate (report-sql.ts H8). Both report reads in
// this file used to re-type its three conditions inline, which is exactly the drift the fragment exists
// to prevent: whatever set of statuses counts as publicly visible, the event gallery and the link
// validator must agree with the report surfaces, or a report progressing past 'published' silently
// disappears from its linked events while still being linkable (or vice versa). Requires alias `r`.
// firstReadyStillLateral is the same story for the PREVIEW half: one join, one policy for which ready
// asset may stand in as a report's thumbnail across the gallery, the map pins, search and post cards.
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

/** The `(cleanup_id, lower(title))` unique index on cleanup_slots (0063). */
const SLOT_TITLE_INDEX = "cleanup_slots_cleanup_title_uidx"

/**
 * Is this a duplicate-slot-title violation? Same shape as certificate-repository.drizzle.ts'
 * `conflictKind`: postgres.js surfaces the violated index on `constraint_name`, and the `detail`
 * fallback ("Key (cleanup_id, lower(title))=…") is belt-and-braces for a driver that ever stops
 * populating it. Narrow on PURPOSE — reconcileSlots also writes rows guarded by
 * cleanup_slots_id_cleanup_uidx, and re-labelling one of those as "duplicate slot title" would hand
 * the host a 422 naming a field that is not the problem.
 */
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
        // B22: the slots land in this SAME transaction, LAST — the lock order is
        // reference_counters -> cleanups -> cleanup_members -> cleanup_reports -> cleanup_slots, and
        // allocateEventReferenceCode staying FIRST is the documented D4 contract (violating it
        // reintroduces ABBA deadlocks across the create paths). Every entry is an insert: on create
        // there is no existing slot to edit, so the service strips any client-supplied `id`.
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
      // Set in the SAME statement as geom (the service re-resolves it from the moved point), so the
      // stored position and its jurisdiction can never disagree. reference_code is untouched by design.
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
          -- The gallery card renders ONE key, so the poster wins and the image's full-size r2_key is the
          -- fallback until its thumb exists. (A non-image only qualifies WITH a poster, so this can never
          -- resolve to a raw .mp4 key — see firstReadyStillLateral.)
          COALESCE(m.thumb_key, m.r2_key) AS thumb_key,
          cr.linked_at
        FROM cleanup_reports cr
        JOIN reports r ON r.id = cr.report_id
        -- THE shared "report's first visible still" join (report-sql.ts), not a local copy: this query used
        -- to hand-roll it with a wider kind guard than the map/search/post-card sites, so a
        -- video-with-poster report showed a thumbnail here and nowhere else.
        ${firstReadyStillLateral(sql)}
        WHERE cr.cleanup_id = ANY(${cleanupIds}::uuid[])
          AND ${publicReportFilter(sql)}
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
        // A row with no measurable distance cannot anchor the (knn, id) keyset, so the page just ends
        // (pageWith drops the cursor on a null encode) rather than emitting one the WHERE cannot consume.
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
      // Single-statement (atomic) role flip. `role <> 'organizer'` is defense-in-depth: the service
      // already refuses to target the organizer, but the SQL can never demote them regardless.
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
      // Ban + delete + fresh count in ONE transaction so the returned `going` is consistent with the
      // delete AND there is no window between the two writes. Deleting the cleanup_members row drops
      // the target from the event group chat (the same row gates isMember); the cleanup_bans row is
      // what stops them walking straight back in via the self-service join (M17 — before this, removal
      // was purely cosmetic and could be undone by the removed user in a loop).
      //
      // Statement ORDER inside the transaction is not by itself what makes the removal stick — the row
      // lock is. FOR NO KEY UPDATE on the cleanups row conflicts with the FOR SHARE joinCleanupTx takes
      // on the same row, so a concurrent join is serialized against this whole transaction instead of
      // interleaving its (unlocked) ban probe with our delete. Deliberately NOT the stronger FOR UPDATE:
      // that one also conflicts with the FOR KEY SHARE every FK-referencing insert takes on the parent
      // row, which would stall unrelated writes for this event (chat messages, timeline rows, other
      // people's joins) for the length of this transaction. FOR NO KEY UPDATE excludes the join and
      // nothing else. Same reason the join side takes SHARE and not UPDATE.
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
          // B28d: free the seat in the SAME transaction. A removed attendee who kept their claim would
          // occupy a slot forever — a phantom-full row nobody can free and no host can attribute.
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
        // FOR SHARE is what makes the ban probe below race-safe, and it is why the existence probe is
        // also the lock: removeMember takes the conflicting FOR NO KEY UPDATE on this same cleanups row,
        // so a removal either commits entirely before this probe (we see its ban) or waits until after
        // our insert (its delete then removes the membership we just wrote). SHARE rather than an
        // exclusive mode because concurrent joins touch disjoint cleanup_members rows and must not
        // queue behind each other.
        const locked = await tx<{ status: CleanupStatus }[]>`
          SELECT status FROM cleanups WHERE id = ${cleanupId} LIMIT 1 FOR SHARE
        `
        const cleanup = locked[0]
        if (cleanup === undefined) return "not_found"
        if (isCleanupTerminal(cleanup.status)) return "closed"
        // M17: joining was an unconditional self-service INSERT, which made attendee removal a
        // no-op the target could undo instantly. The ban probe runs INSIDE the join transaction, under
        // the row lock above — a bare transaction was NOT sufficient, because a plain SELECT on
        // cleanup_bans takes no lock at all: a removal committing between this probe and the insert
        // below used to leave the target banned AND a member (its delete ran before our insert).
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
        // B18: `status <> 'done'` joined the guard. Host completion is forward-only (B17), so cancel is
        // no longer allowed to walk an event back out of 'done' — that would leave a cancelled event
        // carrying credited volunteer_hours rows, which nothing downstream can interpret.
        const updated = await tx<{ id: string }[]>`
          UPDATE cleanups SET status = 'cancelled'
          WHERE id = ${id} AND status <> 'cancelled' AND status <> 'done'
          RETURNING id
        `
        if (updated.length === 0) {
          // The guarded UPDATE is the concurrency primitive: exactly one of N racing cancels matches a
          // row, so exactly one caller is told "cancelled" and gets to ring the roster. A miss is an
          // already-cancelled event, a COMPLETED one, or no event at all — three different answers
          // (200 / 409 / 404), so the follow-up read returns the status, not merely existence.
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
        // L24: the cancellation fan-out USED to INSERT notification rows directly here, bypassing
        // NotificationService entirely — so it ignored the recipient's push prefs, their quiet hours
        // and their locale, and never emitted the user-channel signal, unlike every other bell in the
        // product. The fan-out now lives in cleanup-service.cancelCleanup and rides the real pipeline.
        // The repo's job ends at the status flip + the timeline row, which is what has to be atomic;
        // a bell is best-effort by design and must never hold a transaction open.
        return "cancelled"
      })
    },

    async completeCleanupTx(
      id: string,
      input: { note: string; actorId: string; now: Date },
    ): Promise<CompleteCleanupOutcome> {
      return sql.begin(async (tx) => {
        // Lock-then-branch (B16). FOR NO KEY UPDATE is removeMember's lock on this same row, so the
        // vocabulary stays consistent and two racing completions serialize: the loser reads status
        // 'done' and returns already_completed, writing nothing. Deliberately NOT the stronger FOR
        // UPDATE, which also conflicts with the FOR KEY SHARE every FK-referencing insert takes on the
        // parent row (chat messages, timeline rows, joins) — see removeMember for the same reasoning.
        const locked = await tx<{ status: CleanupStatus; scheduled_at: Date }[]>`
          SELECT status, scheduled_at FROM cleanups WHERE id = ${id} LIMIT 1 FOR NO KEY UPDATE
        `
        const row = locked[0]
        if (row === undefined) return "not_found"
        if (row.status === "cancelled") return "cancelled"
        // Idempotent: a repeat completion writes NO second timeline row (and the service rings no bell —
        // B19 rings none at all). The caller still gets its 200 + DTO.
        if (row.status === "done") return "already_completed"
        // B14: the time gate is evaluated against the LOCKED scheduled_at, not a value read before the
        // lock — a concurrent updateCleanup moving the date must either commit before this read or wait.
        if (row.scheduled_at.getTime() > input.now.getTime()) return "too_early"
        await tx`UPDATE cleanups SET status = 'done' WHERE id = ${id}`
        // kind='status' reuses the free-text kind the admin setStatus path already writes (the column has
        // no enum), so host completion needs no DDL and renders in the same event timeline.
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
      // B29b: the two LEFT JOINs are the whole "per-slot roster" feature — no second endpoint, no extra
      // visibility rule. The roster is already role-scoped (onlyFollowed for non-members), so the slot
      // field inherits exactly that gating.
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
      // The empty guard loadLinkedReportsForCleanups already uses: a page with no cleanups issues no
      // query at all, which matters because this runs on the hottest list read.
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

          // B23: an id that is not on THIS cleanup is a hard 422, never a silent insert — an id from
          // another event must be a hard error, not a quiet re-parent. Checked BEFORE any write so the
          // whole reconcile is all-or-nothing (the throw rolls this transaction back regardless).
          for (const slot of desired) {
            if (slot.id !== undefined && !have.has(slot.id)) {
              throw AppError.validation({ slots: `unknown slot: ${slot.id}` })
            }
          }

          // ---------------------------------------------------------------------------------------
          // WRITE ORDER IS THE WHOLE POINT OF THIS TRANSACTION.
          //
          // cleanup_slots_cleanup_title_uidx (cleanup_id, lower(title)) is a plain, IMMEDIATELY
          // checked unique index — Postgres has no deferrable unique INDEX, only a deferrable unique
          // CONSTRAINT, and 0063 declares an index. So every INTERMEDIATE state inside this
          // transaction must already satisfy it, not just the final one. Two perfectly ordinary host
          // edits break that if the diff is applied naively:
          //
          //   (a) remove "Grill" and add a new "Grill" in the same save — the INSERT lands while the
          //       old row is still there;
          //   (b) swap two slots' titles — the first UPDATE writes a title the second row still holds.
          //
          // Both raise a raw 23505 that surfaces as a 500 on a legitimate edit. The order below makes
          // every intermediate state legal: DELETE the removed rows first (their titles are freed),
          // then park every RENAMED row on a sentinel title that no host can be holding (its own
          // id::text, unique by construction and unique across the parked set), then write the real
          // titles and the inserts into a board whose remaining keys are exactly those of the rows
          // that legitimately keep them. The only collision left is a genuine duplicate WITHIN
          // `desired`, which the catch below turns into a named 422 instead of a 500.
          // ---------------------------------------------------------------------------------------

          const keep = new Set(desired.map((s) => s.id).filter((id): id is string => id !== undefined))
          const toRemove = [...have.keys()].filter((id) => !keep.has(id))
          const removed: SlotReconcileResult["removed"] = []
          if (toRemove.length > 0) {
            // B23/B34: the claimants are read BEFORE the delete, inside this transaction — after the
            // DELETE the cascade has taken the claim rows and there is nobody left to ring. The read
            // travels WITH the delete, which is why this whole block moves as a unit.
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
            // B24: deleting a claimed slot silently drops its claimants and that is ALLOWED — it is
            // the host's roster and a cancelled role is a legitimate edit. The bell is the mitigation.
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

          // Park the renames. Compared on the RAW title rather than a JS-lowercased one on purpose:
          // parking a row whose lower(title) did not actually change is a harmless extra write, while
          // JS's toLowerCase() disagreeing with Postgres' locale-aware lower() on some exotic
          // character would not be harmless at all.
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
        // Belt-and-braces behind the ordering above: a residual title collision (a duplicate inside
        // `desired` that reached the repo directly, or a concurrent reconcile of the same board) is a
        // NAMED 422 the host can act on, never the unactionable 500 a leaked driver error becomes.
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
        // Statement ORDER here is the B28 contract, not a style choice.
        //
        // FOR SHARE on the cleanups row FIRST mirrors joinCleanupTx exactly and establishes the lock
        // order against removeMember's FOR NO KEY UPDATE on the same row: without it, claim-vs-remove
        // deadlocks ABBA (removal locks cleanups then cleanup_slot_claims; we would lock the slot then
        // block on cleanups). It is also what makes the ban probe below race-safe — a plain SELECT on
        // cleanup_bans locks nothing.
        const locked = await tx<{ status: CleanupStatus }[]>`
          SELECT status FROM cleanups WHERE id = ${cleanupId} LIMIT 1 FOR SHARE
        `
        const cleanup = locked[0]
        if (cleanup === undefined) return { kind: "not_found" }
        // B28e: a completed or cancelled event's roster is the basis for hours attestation, and the
        // auto-RSVP below would hand membership to anyone who showed up afterwards — logEventHours
        // requires current membership, so this would be a credit-laundering path.
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

        // The FOR UPDATE on the SLOT row is what makes count-then-insert safe: two clients racing for
        // the last seat serialize on this lock and the loser's count(*) below sees the winner's row.
        // Moving A -> B needs no lock on A — only B's capacity can be invalidated, and A's count only
        // decreases, which can never falsify anyone else's check.
        const slotRows = await tx<{ capacity: number | null }[]>`
          SELECT capacity FROM cleanup_slots
          WHERE id = ${slotId} AND cleanup_id = ${cleanupId}
          LIMIT 1
          FOR UPDATE
        `
        const slot = slotRows[0]
        if (slot === undefined) return { kind: "slot_not_found" }

        // An idempotent re-claim of the slot the viewer already holds must NOT run the capacity check,
        // or it 409s on a full slot the user is already sitting in.
        if (currentSlotId === slotId) return { kind: "claimed", slotId }

        if (slot.capacity !== null) {
          const counted = await tx<{ n: number }[]>`
            SELECT count(*)::int AS n FROM cleanup_slot_claims WHERE slot_id = ${slotId}
          `
          if ((counted[0]?.n ?? 0) >= slot.capacity) return { kind: "full" }
        }

        // B28b: picking a shift IS an RSVP. The ban probe ran first, so a removed user cannot re-enter
        // through the slot door (M17's whole point).
        //
        // WHY IT SITS HERE AND NOT ABOVE: sql.begin COMMITS on a normal return, and every refusal in
        // this transaction is a normal return, not a throw. Written before the slot lookup, a
        // `slot_not_found` or `full` outcome still committed this row — the caller got a 404/409 while
        // the user had silently been made a member: counted in `going`, on the roster, receiving the
        // event's lifecycle bells and admitted to the private event group chat (cleanup_members.role is
        // the chat gate, chat-room-roles.ts `cleanupRoleOf`), with a client cache that still says
        // not-joined. Only the outcomes that actually seat someone may write it.
        //
        // LOCK ORDER: this makes the claim path take cleanups -> cleanup_slots -> cleanup_members ->
        // cleanup_slot_claims, i.e. members AFTER slots rather than before. That introduces no cycle:
        // no other writer takes a cleanup_slots row lock at all except reconcileSlots (which takes no
        // cleanup_members lock), and the only path that touches cleanup_members before cleanup_slots is
        // createCleanupTx — whose rows are all brand new and therefore unlockable by anyone else until
        // it commits. removeMember/joinCleanupTx, the two writers we can genuinely contend with, are
        // still serialized against us by the FOR SHARE on the cleanups row taken as the FIRST
        // statement above, which is what the ABBA argument in that comment rests on and is unchanged.
        await tx`
          INSERT INTO cleanup_members (cleanup_id, user_id, role)
          VALUES (${cleanupId}, ${userId}, 'member')
          ON CONFLICT (cleanup_id, user_id) DO NOTHING
        `

        // The (cleanup_id, user_id) PK IS the one-slot-per-person rule, so a MOVE is an upsert of
        // slot_id — never a second row, and it releases the old seat in the same statement.
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
      // Releasing does NOT leave the event (B28b): the membership row is untouched and you keep your
      // RSVP. Asymmetric with claiming on purpose.
      const rows = await sql<{ status: CleanupStatus }[]>`
        SELECT status FROM cleanups WHERE id = ${cleanupId} LIMIT 1
      `
      const status = rows[0]?.status
      if (status === undefined) return { kind: "not_found" }
      // Same attestation argument as B28e/B26: after completion the slot roster is the record the
      // credited hours were attested against, so it stops moving in BOTH directions.
      if (isCleanupTerminal(status)) return { kind: "closed" }
      await sql`
        DELETE FROM cleanup_slot_claims WHERE cleanup_id = ${cleanupId} AND user_id = ${userId}
      `
      // Idempotent: released whether or not a claim existed (B28c).
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

/**
 * Insert a create-time slot set (B22). Shared by createCleanupTx so the INSERT column list lives in one
 * place. Deliberately takes a Queryable: it only ever runs inside the caller's transaction.
 */
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

/**
 * The batched slot hydration (B29a) — ONE query for a whole page of cleanups, exactly the shape
 * loadLinkedReportsForCleanups has. `claimed` comes from a grouped sub-select over the claims table and
 * `mine` from a LEFT JOIN on the viewer's own claim; a NULL viewerId makes `mine` false for every row
 * (NULL never equals anything), which is the right anonymous answer rather than a special case.
 */
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

/**
 * The has-more split + cursor derivation for listCleanups, over the canonical `pageWith` (db/cursor-
 * helpers). `cursorOf` stays a parameter because this one function serves BOTH keysets the list has: the
 * near branch anchors on distance (`dist|id`) and the when branch on scheduled_at (`iso|id`). Only the
 * row->record projection is local.
 */
function paginate(
  rows: CleanupRowSelect[],
  limit: number,
  cursorOf: (last: CleanupRowSelect) => string | null,
): { records: CleanupRecord[]; nextCursor: string | null } {
  const { items, nextCursor } = pageWith(rows, limit, cursorOf)
  return { records: items.map(toRecord), nextCursor }
}
