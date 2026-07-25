
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

/**
 * volunteer_hours_audit: append-only journal of every EVENT hours upsert.
 *
 * SECURITY (audit 2026-07-24, M21): logEventHours upserts with `DO UPDATE SET hours = EXCLUDED.hours`,
 * destroying the previous value, and the only actor trace (logged_by_user_id) is overwritten with it —
 * so an inflated credit could be silently restored later and leave no evidence. Hours feed the PUBLIC
 * jurisdiction leaderboard, which makes this a falsifiable public record. One row is written per
 * credited attendee per upsert, in the same transaction. Never updated, never deleted by app code.
 *
 * Intentionally NOT FK'd to volunteer_hours(id): the journal must outlive the row it describes.
 * (cleanup_id, user_id) is the stable natural key — the same pair the upsert conflicts on. Canonical
 * DDL: drizzle/0053_volunteer_hours_audit.sql.
 */
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
    // The host who made the change. NOT NULL — an audit row with no actor is worthless.
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id),
    // NULL = no prior credit existed (first log for this attendee), distinct from a stored 0.
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
