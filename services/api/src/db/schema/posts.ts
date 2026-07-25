/**
 * posts: a first-class social-feed post. Repost / quote / reply are all posts rows disambiguated by
 * `kind` (+ repost_of_id / reply_to_id) so the home timeline is a single scan. Post media reuses
 * media_assets (media_assets.post_id + purpose='post'); attachable event/report cards are the
 * event_id / report_id FKs. Interaction counts (like/repost/reply/save) are denormalized here and
 * bumped in the same txn as the interaction insert/delete.
 *
 * CANONICAL DDL: drizzle/0051_social_posts.sql. This mirror exists for typed queries / diff
 * inspection only; it is NOT applied to create the database. `kind`/`visibility` are app-enforced
 * text (no DB CHECK), mirrored via POST_KIND_VALUES / REPORT_VISIBILITY_VALUES in ./types.js.
 */

import { sql } from "drizzle-orm"
import {
  type AnyPgColumn,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { cleanups } from "./cleanups.js"
import { reports } from "./reports.js"
import { users } from "./users.js"
import type { POST_KIND_VALUES, REPORT_VISIBILITY_VALUES } from "./types.js"

type PostKind = (typeof POST_KIND_VALUES)[number]
type PostVisibility = (typeof REPORT_VISIBILITY_VALUES)[number]

export const posts = pgTable(
  "posts",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    authorId: uuid("author_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").$type<PostKind>().notNull().default("post"),
    body: text("body"),
    visibility: text("visibility").$type<PostVisibility>().notNull().default("public"),
    replyToId: uuid("reply_to_id").references((): AnyPgColumn => posts.id, {
      onDelete: "cascade",
    }),
    threadRootId: uuid("thread_root_id").references((): AnyPgColumn => posts.id, {
      onDelete: "cascade",
    }),
    repostOfId: uuid("repost_of_id").references((): AnyPgColumn => posts.id, {
      onDelete: "cascade",
    }),
    eventId: uuid("event_id").references(() => cleanups.id, { onDelete: "set null" }),
    reportId: uuid("report_id").references(() => reports.id, { onDelete: "set null" }),
    likeCount: integer("like_count").notNull().default(0),
    repostCount: integer("repost_count").notNull().default(0),
    replyCount: integer("reply_count").notNull().default(0),
    saveCount: integer("save_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    index("posts_author_created_idx")
      .on(t.authorId, t.createdAt.desc())
      .where(sql`deleted_at IS NULL`),
    index("posts_reply_to_idx")
      .on(t.replyToId, t.createdAt)
      .where(sql`deleted_at IS NULL`),
    index("posts_repost_of_idx").on(t.repostOfId),
    // Covers the thread_root_id self-FK's ON DELETE CASCADE lookup (0055); partial because only replies
    // carry a thread root.
    index("posts_thread_root_idx")
      .on(t.threadRootId)
      .where(sql`${t.threadRootId} IS NOT NULL`),
    index("posts_event_idx").on(t.eventId),
    index("posts_report_idx").on(t.reportId),
    index("posts_public_recent_idx")
      .on(t.createdAt.desc())
      .where(sql`deleted_at IS NULL AND visibility = 'public'`),
    // At most one repost per user per target (the repost toggle).
    uniqueIndex("posts_repost_unique_idx")
      .on(t.authorId, t.repostOfId)
      .where(sql`kind = 'repost'`),
  ],
)

export type PostRow = typeof posts.$inferSelect
export type NewPostRow = typeof posts.$inferInsert
