/**
 * notifications: in-app notification feed rows. `read_at` null means unread. Two indexes:
 *   - (user_id, created_at DESC) for the chronological feed;
 *   - a PARTIAL index on (user_id) WHERE read_at IS NULL for the cheap unread-count/badge query.
 * The partial index is created in 0001_core.sql (drizzle-kit cannot express a partial index cleanly
 * here), but it is also declared below via `.where(...)` so introspection/diff sees it.
 */

import { sql } from "drizzle-orm"
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { users } from "./users.js"
import type { NOTIFICATION_TYPE_VALUES } from "./types.js"

type NotificationType = (typeof NOTIFICATION_TYPE_VALUES)[number]

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    type: text("type").$type<NotificationType>().notNull(),
    title: text("title").notNull(),
    body: text("body"),
    link: text("link"),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("notifications_user_created_idx").on(t.userId, t.createdAt.desc()),
    index("notifications_user_unread_idx")
      .on(t.userId)
      .where(sql`${t.readAt} is null`),
  ],
)

export type NotificationRow = typeof notifications.$inferSelect
export type NewNotificationRow = typeof notifications.$inferInsert
