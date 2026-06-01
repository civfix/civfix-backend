/**
 * abuse_flags: moderation flags raised against any subject (a report, user, media, cleanup, ...).
 * `subject_type` + `subject_id` is a polymorphic reference (subject_id is text to span uuid + string
 * keys). `source` records who/what raised it (user_report, automated_nsfw, ...). `resolved_at` null
 * means open; a PARTIAL index on the open rows (created in 0001_core.sql) keeps the mod queue fast.
 */

import { sql } from "drizzle-orm"
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core"
import type {
  ABUSE_REASON_VALUES,
  ABUSE_SOURCE_VALUES,
  ABUSE_SUBJECT_TYPE_VALUES,
} from "./types.js"

type AbuseSubjectType = (typeof ABUSE_SUBJECT_TYPE_VALUES)[number]
type AbuseReason = (typeof ABUSE_REASON_VALUES)[number]
type AbuseSource = (typeof ABUSE_SOURCE_VALUES)[number]

export const abuseFlags = pgTable(
  "abuse_flags",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    subjectType: text("subject_type").$type<AbuseSubjectType>().notNull(),
    subjectId: text("subject_id").notNull(),
    reason: text("reason").$type<AbuseReason>().notNull(),
    source: text("source").$type<AbuseSource>().notNull(),
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
