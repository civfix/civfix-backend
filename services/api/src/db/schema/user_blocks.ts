import { sql } from "drizzle-orm"
import { check, index, pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core"
import { users } from "./users.js"

export const userBlocks = pgTable(
  "user_blocks",
  {
    blockerId: uuid("blocker_id")
      .notNull()
      .references(() => users.id),
    blockedId: uuid("blocked_id")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.blockerId, t.blockedId] }),
    index("user_blocks_blocked_idx").on(t.blockedId),
    index("user_blocks_blocker_created_idx").on(
      t.blockerId,
      t.createdAt.desc(),
      t.blockedId.desc(),
    ),
    check("user_blocks_no_self", sql`${t.blockerId} <> ${t.blockedId}`),
  ],
)

export type UserBlockRow = typeof userBlocks.$inferSelect
export type NewUserBlockRow = typeof userBlocks.$inferInsert
