import { index, pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core"
import { chatGroups } from "./chat_groups.js"
import { users } from "./users.js"

export const chatGroupBans = pgTable(
  "chat_group_bans",
  {
    groupId: uuid("group_id")
      .notNull()
      .references(() => chatGroups.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    bannedBy: uuid("banned_by"),
    bannedAt: timestamp("banned_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.groupId, t.userId] }),
    index("chat_group_bans_user_idx").on(t.userId),
  ],
)

export type ChatGroupBanRow = typeof chatGroupBans.$inferSelect
export type NewChatGroupBanRow = typeof chatGroupBans.$inferInsert
