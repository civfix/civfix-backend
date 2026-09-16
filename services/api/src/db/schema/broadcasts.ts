import { sql } from "drizzle-orm"
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { cleanups } from "./cleanups.js"
import { users } from "./users.js"
import type {
  BroadcastChannelValue,
  BroadcastKindValue,
  BroadcastStatusValue,
} from "./types-broadcast.js"

export const broadcasts = pgTable(
  "broadcasts",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    cleanupId: uuid("cleanup_id")
      .notNull()
      .references(() => cleanups.id, { onDelete: "cascade" }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    kind: text("kind").$type<BroadcastKindValue>().notNull(),
    reminderOffsetMin: integer("reminder_offset_min"),
    status: text("status").$type<BroadcastStatusValue>().notNull().default("draft"),
    subject: text("subject"),
    bodyMd: text("body_md"),
    ctaLabel: text("cta_label"),
    ctaUrl: text("cta_url"),
    segment: jsonb("segment"),
    channels: text("channels")
      .array()
      .$type<BroadcastChannelValue[]>()
      .notNull()
      .default(sql`ARRAY['inapp','push','email']::text[]`),
    replyTo: text("reply_to"),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    plannedAt: timestamp("planned_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    chunkSize: integer("chunk_size").notNull().default(200),
    chunkCount: integer("chunk_count").notNull().default(0),
    recipientCount: integer("recipient_count").notNull().default(0),
    sentCount: integer("sent_count").notNull().default(0),
    failedCount: integer("failed_count").notNull().default(0),
    suppressedCount: integer("suppressed_count").notNull().default(0),
    contentScrubbedAt: timestamp("content_scrubbed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("broadcasts_cleanup_created_idx").on(t.cleanupId, t.createdAt.desc(), t.id.desc()),
    index("broadcasts_due_idx")
      .on(t.scheduledAt)
      .where(sql`status = 'scheduled'`),
    index("broadcasts_inflight_idx")
      .on(t.startedAt)
      .where(sql`status = 'sending'`),
    uniqueIndex("broadcasts_reminder_uidx")
      .on(t.cleanupId, t.reminderOffsetMin)
      .where(sql`kind = 'reminder'`),
    uniqueIndex("broadcasts_cancellation_uidx")
      .on(t.cleanupId)
      .where(sql`kind = 'event_cancelled'`),
    index("broadcasts_announcement_public_idx")
      .on(t.cleanupId, t.createdAt.desc(), t.id.desc())
      .where(sql`kind = 'announcement'`),
    index("broadcasts_scrub_idx")
      .on(t.finishedAt)
      .where(sql`content_scrubbed_at IS NULL AND body_md IS NOT NULL AND kind <> 'announcement'`),
    index("broadcasts_admin_log_idx").on(t.createdAt.desc(), t.id.desc()),
  ],
)

export type BroadcastRow = typeof broadcasts.$inferSelect
export type NewBroadcastRow = typeof broadcasts.$inferInsert
