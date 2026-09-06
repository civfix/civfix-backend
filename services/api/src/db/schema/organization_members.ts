import { sql } from "drizzle-orm"
import { index, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { organizations } from "./organizations.js"
import { users } from "./users.js"
import type { ORGANIZATION_MEMBER_ROLE_VALUES } from "./types-host.js"

type OrganizationMemberRole = (typeof ORGANIZATION_MEMBER_ROLE_VALUES)[number]

export const organizationMembers = pgTable(
  "organization_members",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    role: text("role").$type<OrganizationMemberRole>().notNull(),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.userId] }),
    index("organization_members_user_idx").on(t.userId),
    uniqueIndex("organization_members_owner_uidx")
      .on(t.organizationId)
      .where(sql`${t.role} = 'owner'`),
  ],
)

export type OrganizationMemberRow = typeof organizationMembers.$inferSelect
export type NewOrganizationMemberRow = typeof organizationMembers.$inferInsert
