
import { sql } from "drizzle-orm"
import { index, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { mediaAssets } from "./media.js"
import { users } from "./users.js"
import type { GROUP_MEMBER_ROLE_VALUES } from "./types.js"

export type ChatGroupKind = "group" | "channel"

export type ChatGroupVisibility = "private" | "public"

type GroupMemberRole = (typeof GROUP_MEMBER_ROLE_VALUES)[number]

export const chatGroups = pgTable(
  "chat_groups",
  {
    id: uuid("id")
      .notNull()
      .default(sql`gen_random_uuid()`)
      .primaryKey(),
    kind: text("kind").$type<ChatGroupKind>().notNull().default("group"),
    name: text("name").notNull(),
    description: text("description"),
    avatarMediaId: uuid("avatar_media_id").references(() => mediaAssets.id, {
      onDelete: "set null",
    }),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    visibility: text("visibility").$type<ChatGroupVisibility>().notNull().default("private"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("chat_groups_avatar_media_idx")
      .on(t.avatarMediaId)
      .where(sql`${t.avatarMediaId} IS NOT NULL`),
  ],
)

export const chatGroupMembers = pgTable(
  "chat_group_members",
  {
    groupId: uuid("group_id")
      .notNull()
      .references(() => chatGroups.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").$type<GroupMemberRole>().notNull().default("member"),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
    lastReadAt: timestamp("last_read_at", { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.groupId, t.userId] }),
    index("chat_group_members_user_idx").on(t.userId),
  ],
)

export type ChatGroupRow = typeof chatGroups.$inferSelect
export type NewChatGroupRow = typeof chatGroups.$inferInsert
export type ChatGroupMemberRow = typeof chatGroupMembers.$inferSelect
export type NewChatGroupMemberRow = typeof chatGroupMembers.$inferInsert
