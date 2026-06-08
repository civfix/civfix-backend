/**
 * cleanup_members: join table of users participating in a cleanup, with a per-cleanup role
 * (organizer|attendee|...). Composite PK(cleanup_id, user_id) means a user joins a cleanup at most
 * once. Deleting the cleanup cascades; the user FK does not cascade (members survive user soft-delete
 * via the app's soft-delete convention).
 */

import { pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { index } from "drizzle-orm/pg-core"
import { cleanups } from "./cleanups.js"
import { users } from "./users.js"
import type { CLEANUP_MEMBER_ROLE_VALUES } from "./types.js"

type CleanupMemberRole = (typeof CLEANUP_MEMBER_ROLE_VALUES)[number]

export const cleanupMembers = pgTable(
  "cleanup_members",
  {
    cleanupId: uuid("cleanup_id")
      .notNull()
      .references(() => cleanups.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    role: text("role").$type<CleanupMemberRole>().notNull(),
    joinedAt: timestamp("joined_at", { withTimezone: true }).defaultNow(),
    // Chat read watermark: the timestamp of the newest chat message this member has read (NULL = never
    // read; unread baseline falls back to joined_at). Written by the WS `ack` handler, read by the
    // threads service for unread counts. See drizzle/0008_chat_read_state.sql.
    lastReadAt: timestamp("last_read_at", { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.cleanupId, t.userId] }),
    index("cleanup_members_user_idx").on(t.userId),
  ],
)

export type CleanupMemberRow = typeof cleanupMembers.$inferSelect
export type NewCleanupMemberRow = typeof cleanupMembers.$inferInsert
