/**
 * dm_threads: one row per unordered user PAIR for 1:1 direct messages.
 *
 * A thread is unique per pair, stored as (user_lo, user_hi) with user_lo < user_hi (enforced by a CHECK
 * in the canonical SQL) and a UNIQUE(user_lo, user_hi). Combined with ON CONFLICT DO NOTHING this makes
 * openOrCreateThread idempotent regardless of which party initiates. Deleting a thread cascades to its
 * dm_messages / dm_read_state (FKs declared there).
 *
 * The hand-authored SQL is the DDL source of truth: services/api/drizzle/0009_dm_and_privacy.sql. This
 * Drizzle definition mirrors it for type-safe queries only.
 */

import { sql } from "drizzle-orm"
import { check, pgTable, timestamp, unique, uuid } from "drizzle-orm/pg-core"
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
  ],
)

export type DmThreadRow = typeof dmThreads.$inferSelect
export type NewDmThreadRow = typeof dmThreads.$inferInsert
