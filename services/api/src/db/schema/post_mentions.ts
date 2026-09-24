/**
 * Same shape as chat_message_mentions so makeMentionRepo serves both, except that post_id can carry an
 * FK: posts is not partitioned.
 */

import { index, pgTable, primaryKey, uuid } from "drizzle-orm/pg-core"
import { posts } from "./posts.js"
import { users } from "./users.js"

export const postMentions = pgTable(
  "post_mentions",
  {
    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    mentionedUserId: uuid("mentioned_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.postId, t.mentionedUserId] }),
    index("post_mentions_user_idx").on(t.mentionedUserId),
  ],
)

export type PostMentionRow = typeof postMentions.$inferSelect
export type NewPostMentionRow = typeof postMentions.$inferInsert
