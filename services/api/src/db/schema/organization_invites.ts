import { sql } from "drizzle-orm"
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { organizations } from "./organizations.js"
import { users } from "./users.js"
import { citext } from "./types.js"
import type {
  ORGANIZATION_INVITE_ROLE_VALUES,
  ORGANIZATION_INVITE_STATUS_VALUES,
} from "./types-host.js"

type OrganizationInviteRole = (typeof ORGANIZATION_INVITE_ROLE_VALUES)[number]
type OrganizationInviteStatus = (typeof ORGANIZATION_INVITE_STATUS_VALUES)[number]

export const organizationInvites = pgTable(
  "organization_invites",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: citext("email"),
    userId: uuid("user_id").references(() => users.id),
    role: text("role").$type<OrganizationInviteRole>().notNull(),
    tokenHash: text("token_hash").notNull(),
    status: text("status").$type<OrganizationInviteStatus>().notNull().default("pending"),
    invitedBy: uuid("invited_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    check(
      "organization_invites_target_chk",
      sql`${t.email} IS NOT NULL OR ${t.userId} IS NOT NULL`,
    ),
    uniqueIndex("organization_invites_token_uidx").on(t.tokenHash),
    index("organization_invites_org_idx").on(t.organizationId, t.createdAt.desc(), t.id.desc()),
    uniqueIndex("organization_invites_pending_email_uidx")
      .on(t.organizationId, t.email)
      .where(sql`${t.status} = 'pending' and ${t.email} is not null`),
    index("organization_invites_invitee_pending_idx")
      .on(t.userId, t.createdAt.desc(), t.id.desc())
      .where(sql`${t.status} = 'pending' and ${t.userId} is not null`),
    index("organization_invites_invitee_email_pending_idx")
      .on(t.email, t.createdAt.desc(), t.id.desc())
      .where(sql`${t.status} = 'pending' and ${t.email} is not null`),
    index("organization_invites_expiry_idx")
      .on(t.expiresAt)
      .where(sql`${t.status} = 'pending'`),
    index("organization_invites_inviter_pending_idx")
      .on(t.invitedBy)
      .where(sql`${t.status} = 'pending'`),
  ],
)

export type OrganizationInviteRow = typeof organizationInvites.$inferSelect
export type NewOrganizationInviteRow = typeof organizationInvites.$inferInsert
