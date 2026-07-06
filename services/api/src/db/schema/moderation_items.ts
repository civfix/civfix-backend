
import { sql } from "drizzle-orm"
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { users } from "./users.js"
import type {
  MODERATION_KIND_VALUES,
  MODERATION_PRIORITY_VALUES,
  MODERATION_STATUS_VALUES,
  MODERATION_SUBJECT_TYPE_VALUES,
} from "./types.js"

type ModerationKind = (typeof MODERATION_KIND_VALUES)[number]
type ModerationSubjectType = (typeof MODERATION_SUBJECT_TYPE_VALUES)[number]
type ModerationPriority = (typeof MODERATION_PRIORITY_VALUES)[number]
type ModerationStatus = (typeof MODERATION_STATUS_VALUES)[number]

export const moderationItems = pgTable(
  "moderation_items",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    kind: text("kind").$type<ModerationKind>().notNull(),
    subjectType: text("subject_type").$type<ModerationSubjectType>().notNull(),
    subjectId: uuid("subject_id").notNull(),
    flag: text("flag"),
    reason: text("reason"),
    category: text("category"),
    place: text("place"),
    priority: text("priority").$type<ModerationPriority>().notNull().default("med"),
    autoAction: text("auto_action"),
    signals: jsonb("signals").notNull().default([]),
    similar: jsonb("similar").notNull().default([]),
    status: text("status").$type<ModerationStatus>().notNull().default("open"),
    meta: jsonb("meta").notNull().default({}),
    resolvedBy: uuid("resolved_by").references(() => users.id),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("moderation_items_status_created_idx").on(t.status, t.createdAt.desc()),
    index("moderation_items_subject_idx").on(t.subjectType, t.subjectId),
    index("moderation_items_open_idx")
      .on(t.priority, t.createdAt.desc())
      .where(sql`${t.status} = 'open'`),
    uniqueIndex("moderation_items_open_subject_key")
      .on(t.subjectType, t.subjectId)
      .where(sql`${t.status} = 'open'`),
  ],
)

export type ModerationItemRow = typeof moderationItems.$inferSelect
export type NewModerationItemRow = typeof moderationItems.$inferInsert
