/**
 * notification_prefs: one row per user holding per-channel toggles plus optional quiet hours.
 * PK is user_id (1:1 with users). `quiet_start`/`quiet_end` use the pg `time` type (time of day,
 * no timezone); null means quiet hours disabled.
 */

import { boolean, pgTable, time, uuid } from "drizzle-orm/pg-core"
import { users } from "./users.js"

export const notificationPrefs = pgTable("notification_prefs", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id),
  push: boolean("push").notNull().default(true),
  cleanupChat: boolean("cleanup_chat").notNull().default(true),
  reportUpdates: boolean("report_updates").notNull().default(true),
  follows: boolean("follows").notNull().default(true),
  quietStart: time("quiet_start"),
  quietEnd: time("quiet_end"),
})

export type NotificationPrefsRow = typeof notificationPrefs.$inferSelect
export type NewNotificationPrefsRow = typeof notificationPrefs.$inferInsert
