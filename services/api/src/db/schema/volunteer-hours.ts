
import { sql } from "drizzle-orm"
import { index, numeric, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import type { VolunteerHoursSource } from "@civfix/shared"
import { cleanups } from "./cleanups.js"
import { jurisdictions } from "./jurisdictions.js"
import { reports } from "./reports.js"
import { users } from "./users.js"

export const volunteerHours = pgTable(
  "volunteer_hours",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    hours: numeric("hours", { precision: 6, scale: 2 }).notNull(),
    source: text("source").$type<VolunteerHoursSource>().notNull(),
    reportId: uuid("report_id").references(() => reports.id),
    cleanupId: uuid("cleanup_id").references(() => cleanups.id),
    jurisdictionGeoid: text("jurisdiction_geoid").references(() => jurisdictions.geoid),
    loggedByUserId: uuid("logged_by_user_id").references(() => users.id),
    note: text("note"),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("volunteer_hours_user_idx").on(t.userId),
    index("volunteer_hours_user_created_idx").on(t.userId, t.createdAt.desc(), t.id.desc()),
    uniqueIndex("volunteer_hours_report_uidx")
      .on(t.reportId)
      .where(sql`${t.source} = 'report'`),
    uniqueIndex("volunteer_hours_event_uidx")
      .on(t.cleanupId, t.userId)
      .where(sql`${t.source} = 'event'`),
  ],
)

export const userJurisdictionHours = pgTable(
  "user_jurisdiction_hours",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    jurisdictionGeoid: text("jurisdiction_geoid")
      .notNull()
      .references(() => jurisdictions.geoid),
    totalHours: numeric("total_hours", { precision: 8, scale: 2 }).notNull().default("0"),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.jurisdictionGeoid] }),
    index("user_jurisdiction_hours_leaderboard_idx").on(
      t.jurisdictionGeoid,
      t.totalHours.desc(),
      t.userId,
    ),
  ],
)

export const volunteerHoursAudit = pgTable(
  "volunteer_hours_audit",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    cleanupId: uuid("cleanup_id")
      .notNull()
      .references(() => cleanups.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id),
    previousHours: numeric("previous_hours", { precision: 6, scale: 2 }),
    newHours: numeric("new_hours", { precision: 6, scale: 2 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("volunteer_hours_audit_cleanup_idx").on(t.cleanupId, t.createdAt.desc()),
    index("volunteer_hours_audit_actor_idx").on(t.actorUserId, t.createdAt.desc()),
  ],
)

export type VolunteerHoursRow = typeof volunteerHours.$inferSelect
export type NewVolunteerHoursRow = typeof volunteerHours.$inferInsert
export type UserJurisdictionHoursRow = typeof userJurisdictionHours.$inferSelect
export type NewUserJurisdictionHoursRow = typeof userJurisdictionHours.$inferInsert
export type VolunteerHoursAuditRow = typeof volunteerHoursAudit.$inferSelect
export type NewVolunteerHoursAuditRow = typeof volunteerHoursAudit.$inferInsert
