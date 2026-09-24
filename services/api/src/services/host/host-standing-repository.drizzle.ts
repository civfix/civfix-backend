import type { CleanupMemberRole, EventVisibility, OrganizationMemberRole } from "@civfix/shared"
import { NO_HOST_STANDING, type HostStanding } from "@civfix/shared/host"
import type { Queryable } from "../../db/client.js"
import type { HostStandingRepository, HostStandingResolution } from "./host-standing-repository.js"

interface StandingRow {
  cleanup_id: string
  organizer_user_id: string
  organization_id: string | null
  visibility: EventVisibility
  event_role: CleanupMemberRole | null
  org_role: OrganizationMemberRole | null
}

function toResolution(row: StandingRow): HostStandingResolution {
  const standing: HostStanding =
    row.event_role === null && row.org_role === null
      ? NO_HOST_STANDING
      : { eventRole: row.event_role, orgRole: row.org_role }
  return {
    cleanupId: row.cleanup_id,
    standing,
    organizerUserId: row.organizer_user_id,
    organizationId: row.organization_id,
    visibility: row.visibility,
  }
}

export async function hostStandingOf(
  sql: Queryable,
  cleanupId: string,
  userId: string | null,
): Promise<HostStandingResolution | null> {
  const rows = await sql<StandingRow[]>`
    SELECT c.id AS cleanup_id,
           c.organizer_user_id,
           c.organization_id,
           c.visibility,
           m.role AS event_role,
           om.role AS org_role
      FROM cleanups c
      LEFT JOIN cleanup_members m
        ON m.cleanup_id = c.id AND m.user_id = ${userId}::uuid
      LEFT JOIN organizations org ON org.id = c.organization_id AND org.deleted_at IS NULL
      LEFT JOIN organization_members om
        ON om.organization_id = org.id AND om.user_id = ${userId}::uuid
     WHERE c.id = ${cleanupId}
     LIMIT 1`
  const row = rows[0]
  return row === undefined ? null : toResolution(row)
}

export async function hostStandingsOf(
  sql: Queryable,
  cleanupIds: readonly string[],
  userId: string,
): Promise<Map<string, HostStandingResolution>> {
  const out = new Map<string, HostStandingResolution>()
  if (cleanupIds.length === 0) return out
  const rows = await sql<StandingRow[]>`
    SELECT c.id AS cleanup_id,
           c.organizer_user_id,
           c.organization_id,
           c.visibility,
           m.role AS event_role,
           om.role AS org_role
      FROM cleanups c
      LEFT JOIN cleanup_members m ON m.cleanup_id = c.id AND m.user_id = ${userId}
      LEFT JOIN organizations org ON org.id = c.organization_id AND org.deleted_at IS NULL
      LEFT JOIN organization_members om
        ON om.organization_id = org.id AND om.user_id = ${userId}
     WHERE c.id = ANY(${[...cleanupIds]}::uuid[])`
  for (const row of rows) out.set(row.cleanup_id, toResolution(row))
  return out
}

export async function orgStandingOf(
  sql: Queryable,
  organizationId: string,
  userId: string,
): Promise<OrganizationMemberRole | null> {
  const rows = await sql<{ role: OrganizationMemberRole }[]>`
    SELECT om.role
      FROM organization_members om
      JOIN organizations o ON o.id = om.organization_id AND o.deleted_at IS NULL
     WHERE om.organization_id = ${organizationId} AND om.user_id = ${userId}
     LIMIT 1`
  return rows[0]?.role ?? null
}

export function makeDrizzleHostStandingRepository(sql: Queryable): HostStandingRepository {
  return {
    standingOf: (cleanupId, userId) => hostStandingOf(sql, cleanupId, userId),
    standingsOf: (cleanupIds, userId) => hostStandingsOf(sql, cleanupIds, userId),
    orgRoleOf: (organizationId, userId) => orgStandingOf(sql, organizationId, userId),
  }
}
