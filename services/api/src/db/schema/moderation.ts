/**
 * abuse_flags: moderation flags raised against any subject (a report, user, media, cleanup, ...).
 * `subject_type` + `subject_id` is a polymorphic reference (subject_id is text to span uuid + string
 * keys). `source` records who/what raised it (user_report, automated_nsfw, ...). `resolved_at` null
 * means open; a PARTIAL index on the open rows (created in 0001_core.sql) keeps the mod queue fast.
 */

import { sql } from "drizzle-orm"
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core"

export const abuseFlags = pgTable(
  "abuse_flags",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    reason: text("reason").notNull(),
    source: text("source").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [
    index("abuse_flags_subject_idx").on(t.subjectType, t.subjectId),
    index("abuse_flags_open_idx")
      .on(t.createdAt)
      .where(sql`${t.resolvedAt} is null`),
  ],
)

export type AbuseFlagRow = typeof abuseFlags.$inferSelect
export type NewAbuseFlagRow = typeof abuseFlags.$inferInsert
