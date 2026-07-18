
import { sql } from "drizzle-orm"
import { index, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core"
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
    // Nullable: a SYSTEM message (report status/timeline event posted into report chat) has no
    // author. See drizzle/0040_chat_system_messages.sql.
    senderId: uuid("sender_id").references(() => users.id),
    body: text("body"),
    kind: text("kind").$type<ChatMessageKind>().notNull().default("text"),
    attachments: jsonb("attachments"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    // Quoted-reply target. Nullable; no FK (partitioned table, see drizzle/0045_chat_reply_to.sql).
    replyToId: uuid("reply_to_id"),
    // Structured payload for kind:"system" rows. Nullable; NULL on every non-system row.
    systemStatus: text("system_status"),
    systemKind: text("system_kind"),
    systemBody: text("system_body"),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.createdAt] }),
    index("chat_messages_cleanup_created_idx").on(t.cleanupId, t.createdAt.desc()),
    index("chat_messages_report_created_idx").on(t.reportId, t.createdAt.desc()),
    index("chat_messages_sender_created_idx").on(t.senderId, t.createdAt.desc(), t.id.desc()),
  ],
)

export type ChatMessageRow = typeof chatMessages.$inferSelect
export type NewChatMessageRow = typeof chatMessages.$inferInsert
