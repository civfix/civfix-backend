import { sql } from "drizzle-orm"
import type { Db } from "../../db/client.js"
import type { OrganizationMembershipRepository } from "./organization-membership-repository.js"

export function makeDrizzleOrganizationMembershipRepository(
  db: Db,
): OrganizationMembershipRepository {
  return {
    async isActiveMember(id: string, organizationId: string): Promise<boolean> {
      const member = await db.execute<{ one: number }>(sql`
        SELECT 1 AS one
        FROM organization_members m
        JOIN organizations o ON o.id = m.organization_id
        WHERE m.user_id = ${id}
          AND m.organization_id = ${organizationId}
          AND o.deleted_at IS NULL
          AND o.suspended_at IS NULL
        LIMIT 1
      `)
      return member.length > 0
    },
  }
}
