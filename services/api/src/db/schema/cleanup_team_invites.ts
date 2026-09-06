import { sql } from "drizzle-orm"
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { cleanups } from "./cleanups.js"
import { users } from "./users.js"
import { citext } from "./types.js"
import type { EVENT_TEAM_INVITE_STATUS_VALUES, EVENT_TEAM_ROLE_VALUES } from "./types-host.js"

type EventTeamRole = (typeof EVENT_TEAM_ROLE_VALUES)[number]
type EventTeamInviteStatus = (typeof EVENT_TEAM_INVITE_STATUS_VALUES)[number]

export const cleanupTeamInvites = pgTable(
  "cleanup_team_invites",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    cleanupId: uuid("cleanup_id")
      .notNull()
      .references(() => cleanups.id, { onDelete: "cascade" }),
    invitedUserId: uuid("invited_user_id").references(() => users.id),
    invitedEmail: citext("invited_email"),
    role: text("role").$type<EventTeamRole>().notNull(),
    tokenHash: text("token_hash").notNull(),
    status: text("status").$type<EventTeamInviteStatus>().notNull().default("pending"),
    invitedBy: uuid("invited_by").references(() => users.id),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    acceptedBy: uuid("accepted_by").references(() => users.id),
    emailScrubbedAt: timestamp("email_scrubbed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "cleanup_team_invites_target_chk",
      sql`${t.invitedUserId} IS NOT NULL OR ${t.invitedEmail} IS NOT NULL OR ${t.emailScrubbedAt} IS NOT NULL`,
    ),
    uniqueIndex("cleanup_team_invites_token_uidx").on(t.tokenHash),
    index("cleanup_team_invites_cleanup_created_idx").on(
      t.cleanupId,
      t.createdAt.desc(),
      t.id.desc(),
    ),
    uniqueIndex("cleanup_team_invites_pending_user_uidx")
      .on(t.cleanupId, t.invitedUserId)
      .where(sql`${t.status} = 'pending' and ${t.invitedUserId} is not null`),
    uniqueIndex("cleanup_team_invites_pending_email_uidx")
      .on(t.cleanupId, t.invitedEmail)
      .where(sql`${t.status} = 'pending' and ${t.invitedEmail} is not null`),
    index("cleanup_team_invites_expiry_idx")
      .on(t.expiresAt)
      .where(sql`${t.status} = 'pending'`),
    index("cleanup_team_invites_email_scrub_idx")
      .on(t.expiresAt)
      .where(sql`${t.invitedEmail} is not null and ${t.emailScrubbedAt} is null`),
  ],
)

export type CleanupTeamInviteRow = typeof cleanupTeamInvites.$inferSelect
export type NewCleanupTeamInviteRow = typeof cleanupTeamInvites.$inferInsert
