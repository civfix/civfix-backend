/**
 * Per-category notification settings (epic #211, D4). A row exists only for a category the user moved off
 * its NOTIFICATION_CATEGORY_DEFAULTS value, so readers apply the contract default to a missing one.
 */

import type { NotificationCategory } from "@civfix/contract"
import { boolean, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { users } from "./users.js"

export const notificationSettings = pgTable(
  "notification_settings",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    category: text("category").$type<NotificationCategory>().notNull(),
    enabled: boolean("enabled").notNull(),
    push: boolean("push").notNull(),
    email: boolean("email").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.category] })],
)

export type NotificationSettingRow = typeof notificationSettings.$inferSelect
export type NewNotificationSettingRow = typeof notificationSettings.$inferInsert
