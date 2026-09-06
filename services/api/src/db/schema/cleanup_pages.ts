import { sql } from "drizzle-orm"
import {
  bigint,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { cleanups } from "./cleanups.js"
import { users } from "./users.js"
import type { EventPageStatusValue, ThemeAccentValue } from "./types-registration.js"

export const cleanupPages = pgTable(
  "cleanup_pages",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    cleanupId: uuid("cleanup_id")
      .notNull()
      .references(() => cleanups.id, { onDelete: "cascade" }),
    status: text("status").$type<EventPageStatusValue>().notNull().default("draft"),
    themeAccent: text("theme_accent").$type<ThemeAccentValue>().notNull().default("bloom"),
    blocks: jsonb("blocks").notNull().default(sql`'[]'::jsonb`),
    seo: jsonb("seo").notNull().default(sql`'{}'::jsonb`),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    publishedBy: uuid("published_by").references(() => users.id),
    flaggedAt: timestamp("flagged_at", { withTimezone: true }),
    flaggedBy: uuid("flagged_by").references(() => users.id),
    flagReason: text("flag_reason"),
    viewCount: bigint("view_count", { mode: "number" }).notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("cleanup_pages_status_check", sql`${t.status} IN ('draft', 'published', 'unpublished')`),
    check(
      "cleanup_pages_accent_check",
      sql`${t.themeAccent} IN ('bloom', 'moss', 'sun', 'sky', 'lilac')`,
    ),
    check(
      "cleanup_pages_blocks_shape",
      sql`jsonb_typeof(${t.blocks}) = 'array' AND jsonb_array_length(${t.blocks}) <= 24`,
    ),
    check("cleanup_pages_seo_shape", sql`jsonb_typeof(${t.seo}) = 'object'`),
    check("cleanup_pages_view_count_nonneg", sql`${t.viewCount} >= 0`),
    uniqueIndex("cleanup_pages_cleanup_uidx").on(t.cleanupId),
    index("cleanup_pages_published_idx")
      .on(t.publishedAt.desc(), t.id.desc())
      .where(sql`status = 'published'`),
    index("cleanup_pages_flagged_idx")
      .on(t.flaggedAt.desc(), t.id.desc())
      .where(sql`flagged_at IS NOT NULL`),
    index("cleanup_pages_admin_queue_idx").on(
      sql`(COALESCE(published_at, updated_at)) DESC`,
      t.id.desc(),
    ),
  ],
)

export type CleanupPageRow = typeof cleanupPages.$inferSelect
export type NewCleanupPageRow = typeof cleanupPages.$inferInsert
