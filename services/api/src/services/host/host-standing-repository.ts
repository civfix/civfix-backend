import type { EventVisibility, OrganizationMemberRole } from "@civfix/shared"
import type { HostStanding } from "@civfix/shared/host"

export interface HostStandingResolution {
  cleanupId: string
  standing: HostStanding
  organizerUserId: string
  organizationId: string | null
  visibility: EventVisibility
}

export interface HostStandingRepository {
  standingOf(cleanupId: string, userId: string | null): Promise<HostStandingResolution | null>
  standingsOf(
    cleanupIds: readonly string[],
    userId: string,
  ): Promise<Map<string, HostStandingResolution>>
  orgRoleOf(organizationId: string, userId: string): Promise<OrganizationMemberRole | null>
}
