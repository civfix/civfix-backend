import { boolean, pgTable, text, time, uuid } from "drizzle-orm/pg-core"
import { users } from "./users.js"

export const notificationPrefs = pgTable("notification_prefs", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id),
  push: boolean("push").notNull().default(true),
  cleanupChat: boolean("cleanup_chat").notNull().default(true),
  reportUpdates: boolean("report_updates").notNull().default(true),
  follows: boolean("follows").notNull().default(true),
  mentions: boolean("mentions").notNull().default(true),
  postInteractions: boolean("post_interactions").notNull().default(true),
  hostBroadcasts: boolean("host_broadcasts").notNull().default(true),
  quietStart: time("quiet_start"),
  quietEnd: time("quiet_end"),
  tz: text("tz"),
})

export type NotificationPrefsRow = typeof notificationPrefs.$inferSelect
export type NewNotificationPrefsRow = typeof notificationPrefs.$inferInsert
