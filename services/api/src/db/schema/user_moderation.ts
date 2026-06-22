/**
 * user_moderation: trust / abuse side table for users (Phase 2). 1:1 with users via the PK so the
 * core `users` row stays lean.
 *
 * `account_status` drives suspend/ban (banning revokes the user's sessions in the service layer).
 * The "verified neighbor" vs "unverified" trust LABEL is DERIVED at read time (a verified email or any
 * oauth identity makes a verified neighbor) and is NOT stored here. Counts (reports, cleanups) are
 * derived via queries, not stored; `strikes` / `removals` are the moderation tallies. The
 * account_status / risk CHECKs are enforced in 0007_admin_phase2.sql.
 *
 * CANONICAL DDL: drizzle/0007_admin_phase2.sql. This mirror exists for typed queries / diff inspection.
 */

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
    // Earned "report-verified" trust (0030, D7), distinct from the identity "verified neighbor" mark.
    // Earned when a reporter reaches >= 2 operator-approved reports, or set by an explicit admin toggle.
    // NOT NULL DEFAULT false (every other column carries a default, so the upsert in 0030 is safe).
    reportVerified: boolean("report_verified").notNull().default(false),
    reportVerifiedAt: timestamp("report_verified_at", { withTimezone: true }),
    reportVerifiedBy: uuid("report_verified_by").references(() => users.id),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("user_moderation_status_idx").on(t.accountStatus),
    index("user_moderation_flagged_idx")
      .on(t.userId)
      .where(sql`${t.flagged} = true`),
  ],
)

export type UserModerationRow = typeof userModeration.$inferSelect
export type NewUserModerationRow = typeof userModeration.$inferInsert
