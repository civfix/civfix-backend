/**
 * Storage keys whose physical delete failed after the orphan sweep had already deleted their
 * media_assets row. The sweep deletes the row before the objects on purpose (a TOCTOU fix, see
 * MediaWorkerRepo.findOrphans), so without a tombstone a failed delete would strand the object with
 * nothing left to rediscover it. `attempts` caps the retries, and a row at the cap is deliberately kept
 * as the operator-visible record of a permanent leak.
 */

import { sql } from "drizzle-orm"
import { index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core"

export const mediaReapTombstones = pgTable(
  "media_reap_tombstones",
  {
    r2Key: text("r2_key").primaryKey(),
    /** No FK: the media row it names no longer exists. */
    mediaId: uuid("media_id"),
    attempts: integer("attempts").notNull().default(1),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [index("media_reap_tombstones_retry_idx").on(t.attempts, t.createdAt)],
)

export type MediaReapTombstoneRow = typeof mediaReapTombstones.$inferSelect
export type NewMediaReapTombstoneRow = typeof mediaReapTombstones.$inferInsert
