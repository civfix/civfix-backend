/**
 * Social follow graphs. Two tables share this file because they are the same "follow" concept:
 *
 *   follows_people  user -> user follows. PK(follower_id, followee_id). Indexed by followee for
 *                   "who follows me" lookups.
 *   report_follows  user -> report subscriptions (notify me on updates). PK(user_id, report_id),
 *                   ON DELETE CASCADE on the report so deleting a report drops its followers.
 */

import { index, pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core"
import { reports } from "./reports.js"
import { users } from "./users.js"

export const followsPeople = pgTable(
  "follows_people",
  {
    followerId: uuid("follower_id")
      .notNull()
      .references(() => users.id),
    followeeId: uuid("followee_id")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.followerId, t.followeeId] }),
    index("follows_people_followee_idx").on(t.followeeId),
  ],
)

export const reportFollows = pgTable(
  "report_follows",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    reportId: uuid("report_id")
      .notNull()
      .references(() => reports.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.reportId] }),
    index("report_follows_report_idx").on(t.reportId),
  ],
)

export type FollowsPeopleRow = typeof followsPeople.$inferSelect
export type NewFollowsPeopleRow = typeof followsPeople.$inferInsert
export type ReportFollowRow = typeof reportFollows.$inferSelect
export type NewReportFollowRow = typeof reportFollows.$inferInsert
