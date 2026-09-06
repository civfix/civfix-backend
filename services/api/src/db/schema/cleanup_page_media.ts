import { index, pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core"
import { cleanups } from "./cleanups.js"
import { mediaAssets } from "./media.js"

export const cleanupPageMedia = pgTable(
  "cleanup_page_media",
  {
    cleanupId: uuid("cleanup_id")
      .notNull()
      .references(() => cleanups.id, { onDelete: "cascade" }),
    mediaId: uuid("media_id")
      .notNull()
      .references(() => mediaAssets.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.cleanupId, t.mediaId] }),
    index("cleanup_page_media_media_idx").on(t.mediaId),
  ],
)

export type CleanupPageMediaRow = typeof cleanupPageMedia.$inferSelect
export type NewCleanupPageMediaRow = typeof cleanupPageMedia.$inferInsert
