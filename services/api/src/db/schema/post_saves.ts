/**
 * post_saves: one row = one user's private bookmark of one post. Same toggle shape as post_likes;
 * the denormalized posts.save_count is bumped in the same txn. Indexed by (user_id, created_at DESC)
 * for the newest-saved-first GET /me/saves keyset.
 *
 * CANONICAL DDL: drizzle/0051_social_posts.sql. This mirror is for typed queries / diff only.
 */

import { index, pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core"
import { posts } from "./posts.js"
import { users } from "./users.js"

export const postSaves = pgTable(
  "post_saves",
  {
    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.postId, t.userId] }),
    index("post_saves_user_idx").on(t.userId, t.createdAt.desc()),
  ],
)

export type PostSaveRow = typeof postSaves.$inferSelect
export type NewPostSaveRow = typeof postSaves.$inferInsert
