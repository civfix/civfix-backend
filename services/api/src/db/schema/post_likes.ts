/**
 * post_likes: one row = one user's like on one post. Composite PK(post_id, user_id) de-dupes and
 * makes the like toggle a single INSERT ... ON CONFLICT DO NOTHING / DELETE; the denormalized
 * posts.like_count is bumped in the same txn. Both columns FK real uuid PKs with ON DELETE CASCADE
 * (cleaner than the chat_message_reactions precedent, which cannot FK the partitioned message tables).
 *
 * CANONICAL DDL: drizzle/0051_social_posts.sql. This mirror is for typed queries / diff only.
 */

import { index, pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core"
import { posts } from "./posts.js"
import { users } from "./users.js"

export const postLikes = pgTable(
  "post_likes",
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
    index("post_likes_user_idx").on(t.userId),
  ],
)

export type PostLikeRow = typeof postLikes.$inferSelect
export type NewPostLikeRow = typeof postLikes.$inferInsert
