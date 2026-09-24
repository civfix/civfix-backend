/**
 * One row per unordered user pair, stored ordered (user_lo < user_hi) under a UNIQUE so that, with
 * ON CONFLICT DO NOTHING, openOrCreateThread is idempotent regardless of which party initiates.
 */

import { sql } from "drizzle-orm"
import { check, index, pgTable, timestamp, unique, uuid } from "drizzle-orm/pg-core"
import { users } from "./users.js"

export const dmThreads = pgTable(
  "dm_threads",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userLo: uuid("user_lo")
      .notNull()
      .references(() => users.id),
    userHi: uuid("user_hi")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("dm_threads_user_lo_user_hi_key").on(t.userLo, t.userHi),
    check("dm_threads_lo_lt_hi", sql`${t.userLo} < ${t.userHi}`),
    // The UNIQUE(user_lo, user_hi) gives user_hi no leftmost-prefix coverage; this index lets the inbox
    // `user_lo = X OR user_hi = X` filter BitmapOr both branches.
    index("dm_threads_user_hi_idx").on(t.userHi),
  ],
)

export type DmThreadRow = typeof dmThreads.$inferSelect
export type NewDmThreadRow = typeof dmThreads.$inferInsert
