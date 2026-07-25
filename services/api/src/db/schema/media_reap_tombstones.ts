/**
 * media_reap_tombstones: R2 keys whose physical delete failed AFTER the orphan sweep had already deleted
 * their media_assets row (drizzle/0057_media_reap_tombstones.sql).
 *
 * The sweep deletes the row before the objects on purpose (a TOCTOU fix — see MediaWorkerRepo.findOrphans
 * and jobs/orphan-sweep.ts), which means a failed storage DELETE would otherwise strand the object with
 * nothing left in the database to rediscover it. A tombstone is the durable "still owes a delete" note the
 * next sweep retries from; `attempts` caps the retries and the row is deliberately KEPT at the cap as the
 * operator-visible record of a permanent leak.
 *
 * media_id is informational only and intentionally has no .references() — the media row it names is gone.
 */

import { sql } from "drizzle-orm"
import { index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core"

export const mediaReapTombstones = pgTable(
  "media_reap_tombstones",
  {
    /** The R2 object key still owed a delete. PK: the key IS the identity of the pending work. */
    r2Key: text("r2_key").primaryKey(),
    /** The reaped media_assets row this key came from. No FK — that row no longer exists. */
    mediaId: uuid("media_id"),
    /** Failed delete attempts so far (1 on the first record). Bounds the retry loop. */
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
