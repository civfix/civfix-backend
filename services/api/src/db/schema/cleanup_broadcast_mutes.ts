import { index, pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core"
import { cleanups } from "./cleanups.js"
import { users } from "./users.js"

export const cleanupBroadcastMutes = pgTable(
  "cleanup_broadcast_mutes",
  {
    cleanupId: uuid("cleanup_id")
      .notNull()
      .references(() => cleanups.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.cleanupId, t.userId] }),
    index("cleanup_broadcast_mutes_user_idx").on(t.userId),
  ],
)

export type CleanupBroadcastMuteRow = typeof cleanupBroadcastMutes.$inferSelect
export type NewCleanupBroadcastMuteRow = typeof cleanupBroadcastMutes.$inferInsert
