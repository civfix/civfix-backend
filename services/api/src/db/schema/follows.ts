/**
 * Social follow graph:
 *
 *   follows_people  user -> user follows. PK(follower_id, followee_id). Indexed by followee for
 *                   "who follows me" lookups.
 *
 * (The former report_follows table — user -> report notify-me subscriptions — was dropped with the
 * discussion system, 0044_drop_report_discussion.sql.)
 */

import { index, pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core"
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

export type FollowsPeopleRow = typeof followsPeople.$inferSelect
export type NewFollowsPeopleRow = typeof followsPeople.$inferInsert
