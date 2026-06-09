/**
 * user_blocks: directed block edges between users.
 *
 * Blocking hides the DM thread for BOTH sides (a thread is excluded from the threads list when blocked
 * either way) and rejects sends in the WS gateway. PK(blocker_id, blocked_id) makes block idempotent; a
 * CHECK forbids self-blocks; the blocked_id index serves the reverse ("who blocked me?") lookups used in
 * the bidirectional block test (isBlockedEitherWay).
 *
 * Canonical DDL: services/api/drizzle/0009_dm_and_privacy.sql.
 */

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
    check("user_blocks_no_self", sql`${t.blockerId} <> ${t.blockedId}`),
  ],
)

export type UserBlockRow = typeof userBlocks.$inferSelect
export type NewUserBlockRow = typeof userBlocks.$inferInsert
