import type { Sql } from "../../db/client.js"
import { makeOrganizationAdminMethods } from "./organization-repository-admin.drizzle.js"
import { makeOrganizationInviteMethods } from "./organization-repository-invites.drizzle.js"
import { makeOrganizationMemberMethods } from "./organization-repository-members.drizzle.js"
import { makeOrganizationProfileMethods } from "./organization-repository-profile.drizzle.js"
import type { OrganizationRepository } from "./organization-repository.types.js"
import { makeOrganizationVerificationMethods } from "./organization-repository-verification.drizzle.js"

export function makeDrizzleOrganizationRepository(sql: Sql): OrganizationRepository {
  return {
    ...makeOrganizationProfileMethods(sql),
    ...makeOrganizationMemberMethods(sql),
    ...makeOrganizationVerificationMethods(sql),
    ...makeOrganizationAdminMethods(sql),
    ...makeOrganizationInviteMethods(sql),
  }
}
