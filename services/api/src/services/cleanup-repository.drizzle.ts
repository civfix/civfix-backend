/**
 * Postgres-backed CleanupRepository (the production implementation of the cleanups persistence seam).
 *
 * ALL cleanup + membership access flows through here so the cleanup service stays infra-free and
 * unit-testable with an in-memory repo. Written against the raw postgres-js tag (`Sql`) rather than the
 * Drizzle query builder because every cleanup touches PostGIS geometry (ST_SetSRID(ST_MakePoint) on
 * write; ST_X/ST_Y on read; ST_MakeEnvelope / ST_Distance for bbox/near), which Drizzle does not model.
 * Using one tag throughout also lets the create flow run as a SINGLE transaction (sql.begin), which is
 * what guarantees membership == chat membership atomicity.
 *
 * CREATE TRANSACTION (createCleanupTx):
 *   1. INSERT the cleanups row (geom from the point, status/type/title/description/bring/address as
 *      decided by the service).
 *   2. INSERT the organizer's cleanup_members(role 'organizer') row.
 *   3. Read the row back (decoding geom, joining the organizer person + member count) and return it.
 *   All three happen in ONE transaction: a failure rolls back the row AND the membership together, so an
 *   organizer is never left without chat access and no orphan membership survives.
 *
 * DISTANCE: when a `near` point is supplied, distance is measured with ST_Distance over geography casts
 * (metres). bbox filtering uses ST_Intersects against ST_MakeEnvelope. Pagination is keyset:
 *   - near listings page by (distance ASC, id ASC) with a numeric `${dist}|${id}` cursor;
 *   - non-near listings page by scheduled_at (ASC for upcoming/none, DESC for past) with an
 *     `${iso}|${id}` cursor. The id tiebreak keeps a total order when timestamps/distances collide.
 * The `|` delimiter cannot appear in an ISO-8601 timestamp or a UUID, so splitting is unambiguous.
 */

import type postgres from "postgres"
import type { Queryable, Sql } from "../db/client.js"
import type {
  AttendeeView,
  CleanupBBox,
  CleanupPersonView,
  CleanupRecord,
  CleanupRepository,
  CreateCleanupTxArgs,
  LinkedEventView,
  LinkedReportView,
  ListAttendeesArgs,
  ListCleanupsFilters,
  NearPoint,
  UpdateCleanupPatch,
} from "./cleanup-service.js"
import type {
  CleanupStatus,
  CleanupType,
  EventKind,
  ReportCategory,
  ReportStatus,
} from "@civfix/shared"

/** Shape of a cleanup row as selected back (geom decoded, organizer joined, going counted). */
interface CleanupRowSelect {
  id: string
  organizer_user_id: string
  type: CleanupType
  event_kind: EventKind
  title: string
  description: string | null
  lng: number
  lat: number
  scheduled_at: Date
  status: CleanupStatus
  bring: string[] | null
  address: string | null
  created_at: Date
  going: number
  dist: number | null
  org_display_name: string
  org_handle: string | null
  org_bio: string | null
  org_verified: boolean
}

/** Shape of an attendee row selected for the roster (person fields + the viewer's follow flag). */
interface AttendeeRowSelect {
  id: string
  display_name: string
  handle: string | null
  bio: string | null
  is_following: boolean
}

/** Project a selected cleanup row into the structural CleanupRecord the service consumes. */
function toRecord(r: CleanupRowSelect): CleanupRecord {
  const organizer: CleanupPersonView = {
    id: r.organizer_user_id,
    displayName: r.org_display_name,
    handle: r.org_handle,
    bio: r.org_bio,
    verified: r.org_verified,
  }
  return {
    id: r.id,
    organizerUserId: r.organizer_user_id,
    type: r.type,
    eventKind: r.event_kind,
    title: r.title,
    description: r.description,
    lat: r.lat,
    lng: r.lng,
    scheduledAt: r.scheduled_at,
    status: r.status,
    bring: r.bring,
    address: r.address,
    createdAt: r.created_at,
    going: r.going,
    // postgres returns numeric distance as a string; normalize to number | null.
    dist: r.dist === null ? null : Number(r.dist),
    organizer,
  }
}

/**
 * The SELECT list shared by every cleanup read. `near` toggles a distance expression (metres via the
 * geography cast); when absent, dist is a literal NULL so the column shape stays stable. The going count
 * comes from the pre-aggregated `g` join (see `goingJoin`) rather than a correlated per-row subquery, so
 * a list page computes the member count once per cleanup set-wise instead of N index probes. The organizer
 * person fields are joined inline so a single round-trip builds the whole DTO.
 *
 * INVARIANT: every query selecting these columns MUST also include `goingJoin(sql)` so `g.going` resolves;
 * COALESCE keeps cleanups with zero members at 0 (the LEFT JOIN yields NULL for them).
 */
function cleanupColumns(sql: Queryable, near: NearPoint | null) {
  const distExpr =
    near !== null
      ? sql`ST_Distance(c.geom::geography, ST_SetSRID(ST_MakePoint(${near.lng}, ${near.lat}), 4326)::geography)`
      : sql`NULL`
  return sql`
    c.id,
    c.organizer_user_id,
    c.type,
    c.event_kind,
    c.title,
    c.description,
    ST_X(c.geom) AS lng,
    ST_Y(c.geom) AS lat,
    c.scheduled_at,
    c.status,
    c.bring,
    c.address,
    c.created_at,
    COALESCE(g.going, 0) AS going,
    ${distExpr} AS dist,
    u.display_name AS org_display_name,
    u.handle AS org_handle,
    u.bio AS org_bio,
    EXISTS (
      SELECT 1 FROM user_verification v
      WHERE v.user_id = c.organizer_user_id AND v.status = 'verified'
    ) AS org_verified
  `
}

/**
 * Pre-aggregated member-count join used by every query that selects `cleanupColumns`. Replaces the old
 * correlated `(SELECT count(*) ... WHERE m.cleanup_id = c.id)` subquery: instead of one index probe per
 * returned row, the member count is grouped once and joined by cleanup_id. For a single-row read this is
 * equivalent work; for a list page it collapses N correlated counts into one aggregate scan.
 */
function goingJoin(sql: Queryable) {
  return sql`LEFT JOIN (
    SELECT cleanup_id, count(*)::int AS going FROM cleanup_members GROUP BY cleanup_id
  ) g ON g.cleanup_id = c.id`
}

export function makeDrizzleCleanupRepository(sql: Sql): CleanupRepository {
  /** Read one cleanup by id (optionally with distance), sharing the given tag (pool or tx). */
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
      const record = await sql.begin(async (tx) => {
        // 1) Insert the cleanup. geom is built from the point in SQL; bring stays a text[].
        await tx`
          INSERT INTO cleanups (
            id, organizer_user_id, type, event_kind, title, description, geom, scheduled_at, status,
            bring, address
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
            ${args.address}
          )
        `

        // 2) Auto-join the organizer in the SAME transaction (membership == chat membership, atomic).
        await tx`
          INSERT INTO cleanup_members (cleanup_id, user_id, role)
          VALUES (${args.cleanupId}, ${args.organizerUserId}, 'organizer')
          ON CONFLICT (cleanup_id, user_id) DO NOTHING
        `

        // 3) Link the initial reports (junction rows + a 'report_linked' cleanup_timeline row each), in
        // the SAME tx so a rolled-back create leaves no orphan links. The service has already validated the
        // ids are visible; ON CONFLICT DO NOTHING keeps a duplicate id idempotent.
        await linkReportsInTx(tx, args.cleanupId, args.linkedReportIds, args.organizerUserId)

        // 4) Read the persisted state back inside the tx (no `near` at create time -> dist NULL).
        const created = await readById(tx, args.cleanupId, null)
        // created cannot be null: we just inserted it within this same transaction.
        return created!
      })
      return record
    },

    async updateCleanup(id: string, patch: UpdateCleanupPatch): Promise<boolean> {
      // Build the SET list from only the supplied fields. lat+lng (both present) rebuild geom; supplying
      // neither leaves the position untouched. An empty patch still confirms existence (no-op UPDATE).
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
        // No scalar change requested: just confirm the cleanup exists so the service can 404 a missing id.
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
        for (const reportId of toRemove) {
          await tx`
            DELETE FROM cleanup_reports WHERE cleanup_id = ${cleanupId} AND report_id = ${reportId}
          `
          await tx`
            INSERT INTO cleanup_timeline (cleanup_id, kind, note, actor_id)
            VALUES (${cleanupId}, 'report_unlinked', ${`Unlinked report ${reportId}`}, ${actorId})
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
      // Only published+public, non-deleted reports leak into the gallery (held/hidden never). The thumb is
      // the first ready media's thumb_key (or its r2_key) via a LATERAL pick, mirroring the report read's
      // ready-only media rule. Ordered by linked_at DESC so the newest links lead.
      const rows = await sql<
        {
          cleanup_id: string
          id: string
          category: ReportCategory
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
      // The events a report is linked to, with the organizer person + going count (pre-aggregated) +
      // eventKind + the cleanup's real lifecycle status. Ordered by linked_at DESC so the newest links lead.
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
        LEFT JOIN (
          SELECT cleanup_id, count(*)::int AS going FROM cleanup_members GROUP BY cleanup_id
        ) g ON g.cleanup_id = c.id
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

    async listCleanups(
      filters: ListCleanupsFilters,
    ): Promise<{ records: CleanupRecord[]; nextCursor: string | null }> {
      const near = filters.near ?? null
      const whenFilter = buildWhenFilter(sql, filters.when)
      const bboxFilter = buildBboxFilter(sql, filters.bbox)

      if (near !== null) {
        // ----- near: order by distance ASC, id ASC; cursor is `${dist}:${id}` -----
        const cursor = parseNearCursor(filters.cursor)
        const cursorFilter =
          cursor !== null
            ? sql`AND (
                ST_Distance(c.geom::geography, ST_SetSRID(ST_MakePoint(${near.lng}, ${near.lat}), 4326)::geography),
                c.id
              ) > (${cursor.dist}::float8, ${cursor.id}::uuid)`
            : sql``
        const rows = await sql<CleanupRowSelect[]>`
          SELECT ${cleanupColumns(sql, near)}
          FROM cleanups c
          JOIN users u ON u.id = c.organizer_user_id
          ${goingJoin(sql)}
          WHERE TRUE
            ${whenFilter}
            ${bboxFilter}
            ${cursorFilter}
          ORDER BY dist ASC, c.id ASC
          LIMIT ${filters.limit + 1}
        `
        return paginate(rows, filters.limit, (last) =>
          last.dist === null ? null : `${Number(last.dist)}|${last.id}`,
        )
      }

      // ----- non-near: order by scheduled_at (ASC upcoming/none, DESC past); cursor `${iso}:${id}` -----
      const past = filters.when === "past"
      const cursor = parseTimeCursor(filters.cursor)
      const cursorFilter =
        cursor !== null
          ? past
            ? sql`AND (c.scheduled_at, c.id) < (${cursor.at}, ${cursor.id}::uuid)`
            : sql`AND (c.scheduled_at, c.id) > (${cursor.at}, ${cursor.id}::uuid)`
          : sql``
      const order = past ? sql`ORDER BY c.scheduled_at DESC, c.id DESC` : sql`ORDER BY c.scheduled_at ASC, c.id ASC`
      const rows = await sql<CleanupRowSelect[]>`
        SELECT ${cleanupColumns(sql, null)}
        FROM cleanups c
        JOIN users u ON u.id = c.organizer_user_id
        ${goingJoin(sql)}
        WHERE TRUE
          ${whenFilter}
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

    async membersOf(cleanupIds: string[], userId: string): Promise<Set<string>> {
      if (cleanupIds.length === 0) return new Set()
      // One query for the whole page: which of these cleanups is the user a member of? Mirrors the single
      // isMember probe (PK(cleanup_id, user_id)) but batched over the page via ANY(uuid[]).
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
      // Run inside a transaction so the existence check + upsert are consistent. The membership upsert is
      // idempotent via ON CONFLICT DO NOTHING (re-joining is a no-op == chat membership stays single).
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

    async listAttendees(args: ListAttendeesArgs): Promise<AttendeeView[]> {
      const { cleanupId, viewerId, onlyFollowed, limit } = args
      // The viewer's follow edge per attendee. An anonymous viewer follows no one (FALSE). Mirrors the
      // social repo's EXISTS pattern so isFollowing stays consistent across screens.
      const followingExpr =
        viewerId !== null
          ? sql`EXISTS (SELECT 1 FROM follows_people f WHERE f.follower_id = ${viewerId} AND f.followee_id = u.id)`
          : sql`FALSE`
      // "Not yet RSVP'd" gate: restrict to followed attendees. Anonymous + onlyFollowed => nothing.
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
  }
}

// ---------------------------------------------------------------------------
// Link helper (shared by createCleanupTx / linkReports / reconcileLinkedReports)
// ---------------------------------------------------------------------------

/**
 * Insert a cleanup_reports row (ON CONFLICT DO NOTHING) + a 'report_linked' cleanup_timeline row for each
 * report id that was NOT already linked, using the given tx tag (so it composes inside a larger
 * transaction). Returns the ids that were newly linked (a duplicate id is skipped, keeping the link +
 * its timeline row idempotent). An empty input is a no-op. The actor is recorded on both the junction
 * (linked_by_user_id) and the timeline row.
 */
async function linkReportsInTx(
  tx: Queryable,
  cleanupId: string,
  reportIds: string[],
  actorId: string | null,
): Promise<string[]> {
  const newlyLinked: string[] = []
  for (const reportId of reportIds) {
    const inserted = await tx<{ id: string }[]>`
      INSERT INTO cleanup_reports (cleanup_id, report_id, linked_by_user_id)
      VALUES (${cleanupId}, ${reportId}, ${actorId})
      ON CONFLICT (cleanup_id, report_id) DO NOTHING
      RETURNING id
    `
    if (inserted.length > 0) {
      newlyLinked.push(reportId)
      await tx`
        INSERT INTO cleanup_timeline (cleanup_id, kind, note, actor_id)
        VALUES (${cleanupId}, 'report_linked', ${`Linked report ${reportId}`}, ${actorId})
      `
    }
  }
  return newlyLinked
}

// ---------------------------------------------------------------------------
// Query fragment + cursor helpers
// ---------------------------------------------------------------------------

/**
 * Time/status predicate fragment:
 *   - "upcoming": scheduled_at >= now() AND status <> 'cancelled'
 *   - "past":     scheduled_at <  now()
 *   - omitted:    no time filter, but still excludes 'cancelled' (cancelled events are hidden).
 * Mirrors the GET /map/cleanups predicate so the list + map feeds agree.
 */
function buildWhenFilter(sql: Sql, when: "upcoming" | "past" | undefined) {
  if (when === "upcoming") return sql`AND c.scheduled_at >= now() AND c.status <> 'cancelled'`
  if (when === "past") return sql`AND c.scheduled_at < now()`
  return sql`AND c.status <> 'cancelled'`
}

/** Optional bbox intersection fragment (empty when no bbox). */
function buildBboxFilter(sql: Sql, bbox: CleanupBBox | undefined) {
  if (bbox === undefined) return sql``
  return sql`AND ST_Intersects(
    c.geom,
    ST_MakeEnvelope(${bbox.west}, ${bbox.south}, ${bbox.east}, ${bbox.north}, 4326)
  )`
}

/** Slice limit+1 rows into a page + next cursor, deriving the cursor from the last kept row. */
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

/** Canonical UUID shape; cursor ids are validated before reaching a `${cursor.id}::uuid` cast. */
const CURSOR_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Parse a `${dist}|${id}` near cursor; null when absent/malformed. */
function parseNearCursor(cursor: string | null): { dist: number; id: string } | null {
  if (cursor === null) return null
  const idx = cursor.indexOf("|")
  if (idx <= 0) return null
  const dist = Number(cursor.slice(0, idx))
  const id = cursor.slice(idx + 1)
  // id is cast `${cursor.id}::uuid` downstream; reject a non-UUID (would 22P02 -> 500), degrade to start.
  if (!Number.isFinite(dist) || !CURSOR_UUID_RE.test(id)) return null
  return { dist, id }
}

/** Parse an `${iso}|${id}` time cursor; null when absent/malformed. */
function parseTimeCursor(cursor: string | null): { at: Date; id: string } | null {
  if (cursor === null) return null
  // `|` cannot appear in an ISO timestamp or a UUID, so the first delimiter is the separator.
  const idx = cursor.indexOf("|")
  if (idx <= 0) return null
  const iso = cursor.slice(0, idx)
  const id = cursor.slice(idx + 1)
  const at = new Date(iso)
  // id is cast `${cursor.id}::uuid` downstream; reject a non-UUID (would 22P02 -> 500), degrade to start.
  if (Number.isNaN(at.getTime()) || !CURSOR_UUID_RE.test(id)) return null
  return { at, id }
}
