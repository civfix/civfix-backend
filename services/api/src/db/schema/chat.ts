
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
    senderId: uuid("sender_id")
      .notNull()
      .references(() => users.id),
    body: text("body"),
    kind: text("kind").$type<ChatMessageKind>().notNull().default("text"),
    attachments: jsonb("attachments"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
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
