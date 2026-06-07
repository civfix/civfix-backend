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

import type { Queryable, Sql } from "../db/client.js"
import type {
  AttendeeView,
  CleanupBBox,
  CleanupPersonView,
  CleanupRecord,
  CleanupRepository,
  CreateCleanupTxArgs,
  ListAttendeesArgs,
  ListCleanupsFilters,
  NearPoint,
} from "./cleanup-service.js"
import type { CleanupStatus, CleanupType } from "@civfix/shared"

/** Shape of a cleanup row as selected back (geom decoded, organizer joined, going counted). */
interface CleanupRowSelect {
  id: string
  organizer_user_id: string
  type: CleanupType
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
  }
  return {
    id: r.id,
    organizerUserId: r.organizer_user_id,
    type: r.type,
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
 * and organizer person fields are joined inline so a single round-trip builds the whole DTO.
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
    c.title,
    c.description,
    ST_X(c.geom) AS lng,
    ST_Y(c.geom) AS lat,
    c.scheduled_at,
    c.status,
    c.bring,
    c.address,
    c.created_at,
    (SELECT count(*)::int FROM cleanup_members m WHERE m.cleanup_id = c.id) AS going,
    ${distExpr} AS dist,
    u.display_name AS org_display_name,
    u.handle AS org_handle,
    u.bio AS org_bio
  `
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
            id, organizer_user_id, type, title, description, geom, scheduled_at, status, bring, address
          ) VALUES (
            ${args.cleanupId},
            ${args.organizerUserId},
            ${args.type},
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

        // 3) Read the persisted state back inside the tx (no `near` at create time -> dist NULL).
        const created = await readById(tx, args.cleanupId, null)
        // created cannot be null: we just inserted it within this same transaction.
        return created!
      })
      return record
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

/** Parse a `${dist}|${id}` near cursor; null when absent/malformed. */
function parseNearCursor(cursor: string | null): { dist: number; id: string } | null {
  if (cursor === null) return null
  const idx = cursor.indexOf("|")
  if (idx <= 0) return null
  const dist = Number(cursor.slice(0, idx))
  const id = cursor.slice(idx + 1)
  if (!Number.isFinite(dist) || id.length === 0) return null
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
  if (Number.isNaN(at.getTime()) || id.length === 0) return null
  return { at, id }
}
