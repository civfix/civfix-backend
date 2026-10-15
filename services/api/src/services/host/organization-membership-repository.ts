export interface OrganizationMembershipRepository {
  isActiveMember(userId: string, organizationId: string): Promise<boolean>
}
