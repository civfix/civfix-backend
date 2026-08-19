
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
    index("notifications_feed_idx")
      .on(t.userId, t.createdAt.desc(), t.id.desc())
      .where(sql`type <> ALL (ARRAY['dm', 'cleanup_chat', 'group_chat', 'report_chat']::text[])`),
    index("notifications_created_idx").on(t.createdAt),
  ],
)

export type NotificationRow = typeof notifications.$inferSelect
export type NewNotificationRow = typeof notifications.$inferInsert
