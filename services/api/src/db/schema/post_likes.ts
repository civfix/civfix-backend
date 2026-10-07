/**
 * The composite PK makes the like toggle a single INSERT ... ON CONFLICT DO NOTHING or DELETE; the
 * denormalized posts.like_count is bumped in the same transaction.
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
  (t) => [primaryKey({ columns: [t.postId, t.userId] }), index("post_likes_user_idx").on(t.userId)],
)

export type PostLikeRow = typeof postLikes.$inferSelect
export type NewPostLikeRow = typeof postLikes.$inferInsert
