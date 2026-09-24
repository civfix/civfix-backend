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
    index("follows_people_follower_created_idx").on(
      t.followerId,
      t.createdAt.desc(),
      t.followeeId.desc(),
    ),
    index("follows_people_followee_created_idx").on(
      t.followeeId,
      t.createdAt.desc(),
      t.followerId.desc(),
    ),
  ],
)

export type FollowsPeopleRow = typeof followsPeople.$inferSelect
export type NewFollowsPeopleRow = typeof followsPeople.$inferInsert
