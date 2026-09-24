import { sql } from "drizzle-orm"
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { cleanups } from "./cleanups.js"
import { users } from "./users.js"

export const cleanupTimeline = pgTable(
  "cleanup_timeline",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    cleanupId: uuid("cleanup_id")
      .notNull()
      .references(() => cleanups.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    note: text("note"),
    actorId: uuid("actor_id").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("cleanup_timeline_cleanup_idx").on(t.cleanupId, t.createdAt)],
)

export type CleanupTimelineRow = typeof cleanupTimeline.$inferSelect
export type NewCleanupTimelineRow = typeof cleanupTimeline.$inferInsert
