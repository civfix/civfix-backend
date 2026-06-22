import type { Queryable, Sql } from "../db/client.js"
import type {
  CleanupBBox,
  CleanupPersonView,
  CleanupRecord,
  NearPoint,
} from "./cleanup-repository.types.js"
import type { CleanupStatus, CleanupType, EventKind } from "@civfix/shared"

// Shape of a cleanup row as selected back (geom decoded, organizer joined, going counted).
export interface CleanupRowSelect {
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

// Shape of an attendee row selected for the roster (person fields + the viewer's follow flag).
export interface AttendeeRowSelect {
  id: string
  display_name: string
  handle: string | null
  bio: string | null
  is_following: boolean
}

export function toRecord(r: CleanupRowSelect): CleanupRecord {
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

// The SELECT list shared by every cleanup read. `near` toggles a distance expression (metres via the
// geography cast); when absent, dist is a literal NULL so the column shape stays stable.
//
// INVARIANT: every query selecting these columns MUST also include `goingJoin(sql)` so `g.going`
// resolves; COALESCE keeps cleanups with zero members at 0 (the LEFT JOIN yields NULL for them).
export function cleanupColumns(sql: Queryable, near: NearPoint | null) {
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

// Pre-aggregated member-count join used by every query that selects `cleanupColumns`. Replaces a
// correlated per-row count subquery: the member count is grouped once and joined by cleanup_id, so a list
// page collapses N correlated counts into one aggregate scan.
export function goingJoin(sql: Queryable) {
  return sql`LEFT JOIN (
    SELECT cleanup_id, count(*)::int AS going FROM cleanup_members GROUP BY cleanup_id
  ) g ON g.cleanup_id = c.id`
}

// Time/status predicate fragment:
//   - "upcoming" / "attending": scheduled_at >= now() AND status <> 'cancelled' (both future windows;
//     "attending" adds a separate membership filter via buildMembershipFilter).
//   - "past":     scheduled_at <  now()
//   - omitted:    no time filter, but still excludes 'cancelled'.
// Mirrors the GET /map/cleanups predicate so the list + map feeds agree.
export function buildWhenFilter(sql: Sql, when: "upcoming" | "past" | "attending" | undefined) {
  if (when === "upcoming" || when === "attending")
    return sql`AND c.scheduled_at >= now() AND c.status <> 'cancelled'`
  if (when === "past") return sql`AND c.scheduled_at < now()`
  return sql`AND c.status <> 'cancelled'`
}

// Viewer-membership predicate for `when: "attending"`: keep only events the viewer is a member of. Empty
// for every other `when`, and matches nothing when there is no viewer (a null user id makes the EXISTS
// false), so an anonymous "attending" list comes back empty.
export function buildMembershipFilter(
  sql: Sql,
  when: string | undefined,
  viewerId: string | null | undefined,
) {
  if (when !== "attending") return sql``
  return sql`AND EXISTS (
    SELECT 1 FROM cleanup_members cm
    WHERE cm.cleanup_id = c.id AND cm.user_id = ${viewerId ?? null}
  )`
}

export function buildBboxFilter(sql: Sql, bbox: CleanupBBox | undefined) {
  if (bbox === undefined) return sql``
  return sql`AND ST_Intersects(
    c.geom,
    ST_MakeEnvelope(${bbox.west}, ${bbox.south}, ${bbox.east}, ${bbox.north}, 4326)
  )`
}
