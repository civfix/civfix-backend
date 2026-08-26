import type { Queryable, Sql } from "../db/client.js"
import type {
  CleanupBBox,
  CleanupPersonView,
  CleanupRecord,
  NearPoint,
} from "./cleanup-repository.types.js"
import type { CleanupMemberRole, CleanupStatus, CleanupType, EventKind } from "@civfix/shared"

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
  jurisdiction_geoid: string | null
  reference_code: string | null
  created_at: Date
  going: number
  guest_count: number
  dist: number | null
  knn?: number | null
  org_display_name: string
  org_handle: string | null
  org_bio: string | null
  org_verified: boolean
}

export interface AttendeeRowSelect {
  id: string
  display_name: string
  handle: string | null
  bio: string | null
  role: CleanupMemberRole
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
    jurisdictionGeoid: r.jurisdiction_geoid,
    referenceCode: r.reference_code,
    createdAt: r.created_at,
    going: r.going,
    guestCount: r.guest_count,
    dist: r.dist === null ? null : Number(r.dist),
    organizer,
  }
}

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
    c.jurisdiction_geoid,
    c.reference_code,
    c.created_at,
    (COALESCE(g.member_count, 0) + COALESCE(g.guest_count, 0)) AS going,
    COALESCE(g.guest_count, 0) AS guest_count,
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

export function memberCountScalar(sql: Queryable) {
  return sql`(SELECT count(*)::int FROM cleanup_members m WHERE m.cleanup_id = c.id)`
}

export function activeGuestCountScalar(sql: Queryable) {
  return sql`(
    SELECT count(*)::int FROM cleanup_guests cg
    WHERE cg.cleanup_id = c.id AND cg.cancelled_at IS NULL
  )`
}

export function goingScalar(sql: Queryable) {
  return sql`(${memberCountScalar(sql)} + ${activeGuestCountScalar(sql)})`
}

export function goingJoin(sql: Queryable) {
  return sql`LEFT JOIN LATERAL (
    SELECT
      ${memberCountScalar(sql)} AS member_count,
      ${activeGuestCountScalar(sql)} AS guest_count
  ) g ON true`
}

export const IN_PROGRESS_GRACE_HOURS = 24

export function buildWhenFilter(sql: Sql, when: "upcoming" | "past" | "attending" | undefined) {
  if (when === "upcoming" || when === "attending")
    return sql`AND c.scheduled_at >= now() - make_interval(hours => ${IN_PROGRESS_GRACE_HOURS})
      AND (c.scheduled_at >= now() OR c.status = 'active')
      AND c.status NOT IN ('cancelled', 'done')`
  if (when === "past")
    return sql`AND c.scheduled_at < now() AND c.status <> 'cancelled'`
  return sql`AND c.status <> 'cancelled'`
}

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
