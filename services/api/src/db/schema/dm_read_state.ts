/**
 * dm_read_state: the per-(thread, user) chat read watermark for direct messages, mirroring
 * cleanup_members.last_read_at. NULL last_read_at = never read (the unread baseline falls back to the
 * thread's created_at). Written by the WS `ack` handler, read by the threads service for unread counts.
 * Composite PK(thread_id, user_id) means one watermark per participant; deleting the thread cascades.
 *
 * Canonical DDL: services/api/drizzle/0009_dm_and_privacy.sql.
 */

import { pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core"
import { dmThreads } from "./dm_threads.js"
import { users } from "./users.js"

export const dmReadState = pgTable(
  "dm_read_state",
  {
    threadId: uuid("thread_id")
      .notNull()
      .references(() => dmThreads.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    lastReadAt: timestamp("last_read_at", { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.threadId, t.userId] })],
)

export type DmReadStateRow = typeof dmReadState.$inferSelect
export type NewDmReadStateRow = typeof dmReadState.$inferInsert
