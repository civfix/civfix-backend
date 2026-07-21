/**
 * post_mentions: one row = one user @-mentioned in one post. Mirrors chat_message_mentions
 * (schema/message_mentions.ts) — keyed by the mentioned USER, drives the post_mention notification
 * (gated by blocks + the `mentions` pref in the service). Unlike the chat table this one CAN FK
 * post_id (posts is a plain uuid PK, not partitioned). Reuses makeMentionRepo(sql, 'post_mentions').
 *
 * CANONICAL DDL: drizzle/0051_social_posts.sql. This mirror is for typed queries / diff only.
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
