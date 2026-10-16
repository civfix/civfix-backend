import type { OrganizationRefDTO, PersonDTO } from "@civfix/contract"

export interface AnnouncementIdentityRepository {
  authorsFor(userIds: readonly (string | null)[]): Promise<Map<string, PersonDTO>>
  organizationFor(cleanupId: string): Promise<OrganizationRefDTO | null>
}
