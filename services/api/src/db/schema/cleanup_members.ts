
import { pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { index } from "drizzle-orm/pg-core"
import { cleanups } from "./cleanups.js"
import { users } from "./users.js"
import type { CLEANUP_MEMBER_ROLE_VALUES } from "./types-host.js"

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
    lastReadAt: timestamp("last_read_at", { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.cleanupId, t.userId] }),
    index("cleanup_members_user_idx").on(t.userId),
  ],
)

export type CleanupMemberRow = typeof cleanupMembers.$inferSelect
export type NewCleanupMemberRow = typeof cleanupMembers.$inferInsert
