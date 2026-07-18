/**
 * chat_groups + chat_group_members: P4 standalone group chats. chat_groups is the room row — a
 * CHANNEL is just a group with kind='channel' (same table, same messages, same membership; the
 * owner/admin-only posting gate for channels is app-level and lands in P5). chat_group_members
 * mirrors report_chat_members (schema/report_chat_members.ts) with a three-tier role ladder
 * (owner|admin|member) and the same last_read_at read watermark convention (NULL = never read;
 * unread baseline falls back to joined_at).
 *
 * CANONICAL DDL: drizzle/0047_chat_groups.sql (which also adds chat_messages.group_id — mirrored
 * in schema/chat.ts). These mirrors exist for typed queries / diff inspection; nothing reads or
 * writes them yet (the groups repo + routes land in the following P4 tasks).
 */

import { sql } from "drizzle-orm"
import { index, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { mediaAssets } from "./media.js"
import { users } from "./users.js"
import type { GROUP_MEMBER_ROLE_VALUES } from "./types.js"

/** chat_groups.kind. Backend-local (see the ConversationMuteRoomKind precedent): 'channel' is the broadcast variant. */
export type ChatGroupKind = "group" | "channel"

/** chat_groups.visibility. 'public' groups are discoverable/joinable; 'private' are invite-only. */
export type ChatGroupVisibility = "private" | "public"

type GroupMemberRole = (typeof GROUP_MEMBER_ROLE_VALUES)[number]

export const chatGroups = pgTable("chat_groups", {
  id: uuid("id")
    .notNull()
    .default(sql`gen_random_uuid()`)
    .primaryKey(),
  kind: text("kind").$type<ChatGroupKind>().notNull().default("group"),
  name: text("name").notNull(),
  description: text("description"),
  // Optional group avatar; ON DELETE SET NULL, same stance as users.avatar_media_id (0019).
  avatarMediaId: uuid("avatar_media_id").references(() => mediaAssets.id, {
    onDelete: "set null",
  }),
  ownerId: uuid("owner_id")
    .notNull()
    .references(() => users.id),
  visibility: text("visibility").$type<ChatGroupVisibility>().notNull().default("private"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

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
    // Chat read watermark, same convention as report_chat_members.lastReadAt: NULL = never read;
    // unread baseline falls back to joined_at.
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
