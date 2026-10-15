import { sql } from "drizzle-orm"
import { index, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { chatGroups } from "./chat_groups.js"
import { cleanups } from "./cleanups.js"
import { reports } from "./reports.js"
import { users } from "./users.js"
import type { CHAT_MESSAGE_KIND_VALUES } from "./types.js"

type ChatMessageKind = (typeof CHAT_MESSAGE_KIND_VALUES)[number]

export const chatMessages = pgTable(
  "chat_messages",
  {
    id: uuid("id")
      .notNull()
      .default(sql`gen_random_uuid()`),
    cleanupId: uuid("cleanup_id").references(() => cleanups.id),
    reportId: uuid("report_id").references(() => reports.id),
    // Exactly one of cleanup_id, report_id, group_id is set (chat_messages_scope_chk, 0047).
    groupId: uuid("group_id").references(() => chatGroups.id),
    // Nullable: a system message has no author.
    senderId: uuid("sender_id").references(() => users.id),
    body: text("body"),
    kind: text("kind").$type<ChatMessageKind>().notNull().default("text"),
    attachments: jsonb("attachments"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    // No FK: Postgres cannot reference a partitioned table by id alone.
    replyToId: uuid("reply_to_id"),
    // pinned_at doubles as the pin-list sort key. pinned_by has no FK, for the same reason as
    // reply_to_id.
    pinnedAt: timestamp("pinned_at", { withTimezone: true }),
    pinnedBy: uuid("pinned_by"),
    systemStatus: text("system_status"),
    systemKind: text("system_kind"),
    systemBody: text("system_body"),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.createdAt] }),
    index("chat_messages_cleanup_created_idx").on(t.cleanupId, t.createdAt.desc()),
    index("chat_messages_report_created_idx").on(t.reportId, t.createdAt.desc()),
    index("chat_messages_group_created_idx").on(t.groupId, t.createdAt.desc()),
    index("chat_messages_sender_created_idx").on(t.senderId, t.createdAt.desc(), t.id.desc()),
    index("chat_messages_cleanup_pinned_idx")
      .on(t.cleanupId, t.pinnedAt.desc())
      .where(sql`pinned_at IS NOT NULL`),
    index("chat_messages_report_pinned_idx")
      .on(t.reportId, t.pinnedAt.desc())
      .where(sql`pinned_at IS NOT NULL`),
    index("chat_messages_group_pinned_idx")
      .on(t.groupId, t.pinnedAt.desc())
      .where(sql`pinned_at IS NOT NULL`),
  ],
)

export type ChatMessageRow = typeof chatMessages.$inferSelect
export type NewChatMessageRow = typeof chatMessages.$inferInsert
