import type { Queryable, Sql } from "../db/client.js"
import type {
  CleanupBBox,
  CleanupOrganizationView,
  CleanupPersonView,
  CleanupRecord,
  NearPoint,
} from "./cleanup-repository.types.js"
import type {
  CleanupMemberRole,
  CleanupStatus,
  CleanupType,
  EventKind,
  EventVisibility,
  OrgVerificationKind,
  OrgVerificationStatus,
} from "@civfix/shared"
import { servedKeyExpr } from "./media-served-key.js"

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
  completed_at: Date | null
  status: CleanupStatus
  bring: string[] | null
  address: string | null
  jurisdiction_geoid: string | null
  reference_code: string | null
  created_at: Date
  capacity: number | null
  going: number
  guest_count: number
  dist: number | null
  knn?: number | null
  org_display_name: string
  org_handle: string | null
  org_bio: string | null
  ends_at: Date | null
  timezone: string | null
  visibility: EventVisibility
  cover_media_id: string | null
  cover_key: string | null
  gallery_media_ids: string[] | null
  donation_url: string | null
  page_slug: string | null
  registration_opens_at: Date | null
  registration_closes_at: Date | null
  organization_id: string | null
  reminder_offsets_min: number[] | null
  host_reply_to: string | null
  host_reply_to_verified_at: Date | null
  organization_slug: string | null
  organization_name: string | null
  organization_logo_key: string | null
  organization_verified_status: OrgVerificationStatus | null
  organization_verified_kind: OrgVerificationKind | null
  organization_suspended: boolean | null
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
  }
  const organization: CleanupOrganizationView | null =
    r.organization_id !== null && r.organization_slug !== null && r.organization_name !== null
      ? {
          id: r.organization_id,
          slug: r.organization_slug,
          name: r.organization_name,
          logoKey: r.organization_logo_key,
          verifiedStatus: r.organization_verified_status ?? "unverified",
          verifiedKind: r.organization_verified_kind,
          suspended: r.organization_suspended === true,
        }
      : null
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
    completedAt: r.completed_at,
    status: r.status,
    bring: r.bring,
    address: r.address,
    jurisdictionGeoid: r.jurisdiction_geoid,
    referenceCode: r.reference_code,
    createdAt: r.created_at,
    capacity: r.capacity,
    going: r.going,
    guestCount: r.guest_count,
    dist: r.dist === null ? null : Number(r.dist),
    organizer,
    endsAt: r.ends_at,
    timezone: r.timezone,
    visibility: r.visibility,
    coverMediaId: r.cover_media_id,
    coverKey: r.cover_key,
    galleryMediaIds: r.gallery_media_ids ?? [],
    donationUrl: r.donation_url,
    pageSlug: r.page_slug,
    registrationOpensAt: r.registration_opens_at,
    registrationClosesAt: r.registration_closes_at,
    organizationId: r.organization_id,
    organization,
    reminderOffsetsMin: r.reminder_offsets_min,
    hostReplyTo: r.host_reply_to,
    hostReplyToVerifiedAt: r.host_reply_to_verified_at,
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
    c.completed_at,
    c.status,
    c.bring,
    c.address,
    c.jurisdiction_geoid,
    c.reference_code,
    c.created_at,
    c.capacity,
    c.ends_at,
    c.timezone,
    c.visibility,
    c.cover_media_id,
    ${servedKeyExpr(sql, "ma")} AS cover_key,
    c.gallery_media_ids,
    c.donation_url,
    c.page_slug,
    c.registration_opens_at,
    c.registration_closes_at,
    c.organization_id,
    c.reminder_offsets_min,
    c.host_reply_to,
    c.host_reply_to_verified_at,
    o.slug AS organization_slug,
    o.name AS organization_name,
    ${servedKeyExpr(sql, "am")} AS organization_logo_key,
    o.verified_status AS organization_verified_status,
    o.verified_kind AS organization_verified_kind,
    (o.suspended_at IS NOT NULL) AS organization_suspended,
    (COALESCE(g.member_count, 0) + COALESCE(g.guest_count, 0)) AS going,
    COALESCE(g.guest_count, 0) AS guest_count,
    ${distExpr} AS dist,
    u.display_name AS org_display_name,
    u.handle AS org_handle,
    u.bio AS org_bio
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

export function eventHostJoins(sql: Queryable) {
  return sql`
    LEFT JOIN media_assets ma ON ma.id = c.cover_media_id
    LEFT JOIN organizations o ON o.id = c.organization_id AND o.deleted_at IS NULL
    LEFT JOIN media_assets am ON am.id = o.logo_media_id`
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

export function buildVisibilityFilter(sql: Sql, viewerId: string | null | undefined) {
  if (viewerId === null || viewerId === undefined) return sql`AND c.visibility = 'public'`
  return sql`AND (
    c.visibility = 'public'
    OR EXISTS (
      SELECT 1 FROM cleanup_members vm
      WHERE vm.cleanup_id = c.id AND vm.user_id = ${viewerId}
    )
    OR EXISTS (
      SELECT 1 FROM organization_members vo
      JOIN organizations vog ON vog.id = vo.organization_id AND vog.deleted_at IS NULL
      WHERE vo.organization_id = c.organization_id AND vo.user_id = ${viewerId}
    )
  )`
}

export function buildBboxFilter(sql: Sql, bbox: CleanupBBox | undefined) {
  if (bbox === undefined) return sql``
  return sql`AND ST_Intersects(
    c.geom,
    ST_MakeEnvelope(${bbox.west}, ${bbox.south}, ${bbox.east}, ${bbox.north}, 4326)
  )`
}
