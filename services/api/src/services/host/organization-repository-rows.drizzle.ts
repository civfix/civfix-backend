import type {
  OrganizationMemberRole,
  OrgVerificationKind,
  OrgVerificationStatus,
  SocialLinks,
} from "@civfix/shared"
import type { Queryable } from "../../db/client.js"
import type { CleanupPersonView } from "../cleanup-repository.types.js"
import { publicServedKeyExpr } from "../media-served-key.js"
import type {
  AdminActorView,
  OrganizationBaseRecord,
  OrganizationRecord,
  OrgHoursTotals,
} from "./organization-repository.types.js"

export const UNKNOWN_PERSON_NAME = "Unknown"

const NO_ORG_HOURS: OrgHoursTotals = { volunteerHours: 0, volunteerCount: 0 }

export interface OrganizationRowSelect {
  id: string
  slug: string
  name: string
  description: string | null
  website_url: string | null
  donation_url: string | null
  logo_media_id: string | null
  logo_key: string | null
  social_links: SocialLinks | null
  verified_status: OrgVerificationStatus
  verified_kind: OrgVerificationKind | null
  verified_at: Date | null
  created_by: string | null
  created_at: Date
  updated_at: Date
  deleted_at: Date | null
  suspended_at: Date | null
  suspended_reason: string | null
  member_count: number
  event_count: number
  my_role: OrganizationMemberRole | null
}

interface OrgHoursRowSelect {
  organization_id: string
  volunteer_hours: number
  volunteer_count: number
}

export async function readOrgHours(
  tag: Queryable,
  organizationIds: readonly string[],
): Promise<Map<string, OrgHoursTotals>> {
  const totals = new Map<string, OrgHoursTotals>()
  if (organizationIds.length === 0) return totals
  const rows = await tag<OrgHoursRowSelect[]>`
    SELECT
      c.organization_id,
      COALESCE(sum(vh.hours), 0)::float8 AS volunteer_hours,
      count(DISTINCT vh.user_id)::int AS volunteer_count
    FROM volunteer_hours vh
    JOIN cleanups c ON c.id = vh.cleanup_id
    JOIN users u ON u.id = vh.user_id
    WHERE c.organization_id = ANY(${[...organizationIds]}::uuid[])
      AND vh.source = 'event'
      AND vh.voided_at IS NULL
      AND u.show_volunteer_hours IS NOT FALSE
    GROUP BY c.organization_id
  `
  for (const row of rows) {
    totals.set(row.organization_id, {
      volunteerHours: Number(row.volunteer_hours),
      volunteerCount: Number(row.volunteer_count),
    })
  }
  return totals
}

export function toOrganizationBaseRecord(row: OrganizationRowSelect): OrganizationBaseRecord {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    websiteUrl: row.website_url,
    donationUrl: row.donation_url,
    logoMediaId: row.logo_media_id,
    logoKey: row.logo_key,
    socialLinks: row.social_links,
    verifiedStatus: row.verified_status,
    verifiedKind: row.verified_kind,
    verifiedAt: row.verified_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    suspendedAt: row.suspended_at,
    suspendedReason: row.suspended_reason,
    memberCount: Number(row.member_count),
    eventCount: Number(row.event_count),
    myRole: row.my_role,
  }
}

export function toOrganizationRecord(
  row: OrganizationRowSelect,
  hours: OrgHoursTotals | undefined,
): OrganizationRecord {
  return { ...toOrganizationBaseRecord(row), ...(hours ?? NO_ORG_HOURS) }
}

/** Assumes the logo join `LEFT JOIN media_assets am ON am.id = o.logo_media_id` is in the FROM. */
export function organizationColumns(sql: Queryable, viewerId: string | null) {
  return sql`
    o.id,
    o.slug,
    o.name,
    o.description,
    o.website_url,
    o.donation_url,
    o.logo_media_id,
    ${publicServedKeyExpr(sql, "am")} AS logo_key,
    o.social_links,
    o.verified_status,
    o.verified_kind,
    o.verified_at,
    o.created_by,
    o.created_at,
    o.updated_at,
    o.deleted_at,
    o.suspended_at,
    o.suspended_reason,
    (SELECT count(*)::int FROM organization_members om WHERE om.organization_id = o.id)
      AS member_count,
    (
      SELECT count(*)::int FROM cleanups c
      WHERE c.organization_id = o.id
        AND (
          (c.visibility = 'public' AND c.status <> 'cancelled')
          OR EXISTS (
            SELECT 1 FROM organization_members vm
            WHERE vm.organization_id = o.id AND vm.user_id = ${viewerId}::uuid
          )
        )
    ) AS event_count,
    (
      SELECT om.role FROM organization_members om
      WHERE om.organization_id = o.id AND om.user_id = ${viewerId}::uuid
      LIMIT 1
    ) AS my_role
  `
}

export function adminActorOf(
  id: string | null,
  name: string | null,
  handle: string | null,
  joined: Date | null,
): AdminActorView | null {
  if (id === null) return null
  return {
    id,
    name: name ?? UNKNOWN_PERSON_NAME,
    handle: handle ?? "",
    joined: joined ?? new Date(0),
  }
}

export function personViewOf(
  person: {
    id: string | null
    name: string | null
    handle: string | null
    bio: string | null
    avatarUrl: string | null
  },
  fallbackName: string,
): CleanupPersonView | null {
  if (person.id === null) return null
  return {
    id: person.id,
    displayName: person.name ?? fallbackName,
    handle: person.handle,
    bio: person.bio,
    avatarUrl: person.avatarUrl,
  }
}
