import type { Sql } from "../../db/client.js"
import { makeOrganizationAdminMethods } from "./organization-admin.drizzle.js"
import { makeOrganizationInviteMethods } from "./organization-invites.drizzle.js"
import { makeOrganizationMemberMethods } from "./organization-members.drizzle.js"
import { makeOrganizationProfileMethods } from "./organization-profile.drizzle.js"
import type { OrganizationRepository } from "./organization-repository.types.js"
import { makeOrganizationVerificationMethods } from "./organization-verification.drizzle.js"

export function makeDrizzleOrganizationRepository(sql: Sql): OrganizationRepository {
  return {
    ...makeOrganizationProfileMethods(sql),
    ...makeOrganizationMemberMethods(sql),
    ...makeOrganizationVerificationMethods(sql),
    ...makeOrganizationAdminMethods(sql),
    ...makeOrganizationInviteMethods(sql),
  }
}
