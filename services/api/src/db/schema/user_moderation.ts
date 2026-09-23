import { sql } from "drizzle-orm"
import { boolean, index, inet, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { users } from "./users.js"
import type { USER_ACCOUNT_STATUS_VALUES, USER_RISK_VALUES } from "./types.js"

type UserAccountStatus = (typeof USER_ACCOUNT_STATUS_VALUES)[number]
type UserRisk = (typeof USER_RISK_VALUES)[number]

export const userModeration = pgTable(
  "user_moderation",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    accountStatus: text("account_status").$type<UserAccountStatus>().notNull().default("active"),
    strikes: integer("strikes").notNull().default(0),
    removals: integer("removals").notNull().default(0),
    risk: text("risk").$type<UserRisk>().notNull().default("low"),
    flagged: boolean("flagged").notNull().default(false),
    flagReason: text("flag_reason"),
    lastDevice: text("last_device"),
    lastIp: inet("last_ip"),
    reportVerified: boolean("report_verified").notNull().default(false),
    reportVerifiedAt: timestamp("report_verified_at", { withTimezone: true }),
    reportVerifiedBy: uuid("report_verified_by").references(() => users.id),
    hostMessagingSuspended: boolean("host_messaging_suspended").notNull().default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("user_moderation_status_idx").on(t.accountStatus),
    index("user_moderation_flagged_idx")
      .on(t.userId)
      .where(sql`${t.flagged} = true`),
    index("user_moderation_host_messaging_idx")
      .on(t.userId)
      .where(sql`${t.hostMessagingSuspended} = true`),
  ],
)

export type UserModerationRow = typeof userModeration.$inferSelect
export type NewUserModerationRow = typeof userModeration.$inferInsert
