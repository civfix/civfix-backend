import {
  AppError,
  type CleanupMemberRole,
  type EventVisibility,
  type HostCapability,
} from "@civfix/shared"
import { can, hostCapabilities, type HostStanding } from "@civfix/shared/host"
import type { Queryable } from "../../db/client.js"
import { hostStandingOf, orgStandingOf, type HostStandingResolution } from "./host-standing.js"

const FORBIDDEN_COPY: Record<HostCapability, string> = {
  view_event_private: "Only the event team can view this.",
  view_roster: "Only the event team can view the roster.",
  view_guest_contact: "Only the event hosts can see guest contact details.",
  view_answers: "Only the event hosts can see registration answers.",
  view_analytics: "Only the event hosts can view analytics.",
  check_in: "Only the event team can check attendees in.",
  manage_event: "Only the event hosts can edit this event.",
  manage_tickets: "Only the event hosts can manage tickets.",
  manage_team: "Only the event organizer can manage the team.",
  broadcast: "Only the event hosts can send messages to attendees.",
  export: "Only the event hosts can export attendee data.",
  manage_page: "Only the event hosts can edit the event page.",
  cancel_event: "Only the event organizer can cancel this event.",
  manage_org_link: "Only the event organizer can change the organization.",
  moderate_chat: "Only the event hosts can moderate the event chat.",
  request_resources: "Only the event organizer can request city resources.",
  manage_org_members: "Only organization admins can manage members.",
}

export function hostForbiddenCopy(capability: HostCapability): string {
  return FORBIDDEN_COPY[capability]
}

export function isEventPubliclyVisible(visibility: EventVisibility): boolean {
  return visibility === "public" || visibility === "unlisted"
}

export function assertMayGrantRole(actor: HostStanding, role: CleanupMemberRole): void {
  const granted = hostCapabilities({ eventRole: role, orgRole: null })
  const held = hostCapabilities(actor)
  for (const capability of granted) {
    if (!held.has(capability)) {
      throw AppError.forbidden("You can't give someone a role with powers you don't hold yourself.")
    }
  }
}

export function hasHostStanding(standing: HostStanding): boolean {
  return standing.eventRole !== null || standing.orgRole !== null
}

export function notFoundCleanup(): AppError {
  return AppError.notFound("Cleanup not found")
}

export async function resolveVisibleStanding(
  sql: Queryable,
  cleanupId: string,
  userId: string | null,
): Promise<HostStandingResolution> {
  const resolution = await hostStandingOf(sql, cleanupId, userId)
  if (resolution === null) throw notFoundCleanup()
  if (!hasHostStanding(resolution.standing) && !isEventPubliclyVisible(resolution.visibility)) {
    throw notFoundCleanup()
  }
  return resolution
}

export async function requireCapability(
  sql: Queryable,
  cleanupId: string,
  userId: string,
  capability: HostCapability,
): Promise<HostStandingResolution> {
  const resolution = await resolveVisibleStanding(sql, cleanupId, userId)
  if (!can(resolution.standing, capability)) throw AppError.forbidden(FORBIDDEN_COPY[capability])
  return resolution
}

export async function requireOrgCapability(
  sql: Queryable,
  organizationId: string,
  userId: string,
  capability: HostCapability,
): Promise<HostStanding> {
  const orgRole = await orgStandingOf(sql, organizationId, userId)
  if (orgRole === null) throw AppError.notFound("Organization not found")
  const standing: HostStanding = { eventRole: null, orgRole }
  if (!can(standing, capability)) throw AppError.forbidden(FORBIDDEN_COPY[capability])
  return standing
}
