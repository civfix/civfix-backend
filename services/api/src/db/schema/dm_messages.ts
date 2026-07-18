
import { sql } from "drizzle-orm"
import { index, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { dmThreads } from "./dm_threads.js"
import { users } from "./users.js"
import type { CHAT_MESSAGE_KIND_VALUES } from "./types.js"

type ChatMessageKind = (typeof CHAT_MESSAGE_KIND_VALUES)[number]

export const dmMessages = pgTable(
  "dm_messages",
  {
    id: uuid("id")
      .notNull()
      .default(sql`gen_random_uuid()`),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => dmThreads.id, { onDelete: "cascade" }),
    senderId: uuid("sender_id")
      .notNull()
      .references(() => users.id),
    body: text("body"),
    kind: text("kind").$type<ChatMessageKind>().notNull().default("text"),
    attachments: jsonb("attachments"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    // Quoted-reply target. Nullable; no FK (see drizzle/0045_chat_reply_to.sql).
    replyToId: uuid("reply_to_id"),
    // Pin state (P3): pinned_at NULL = not pinned; doubles as the pin-list sort key. pinned_by has
    // no FK (mirrors chat_messages' shape — see drizzle/0046_chat_pins.sql).
    pinnedAt: timestamp("pinned_at", { withTimezone: true }),
    pinnedBy: uuid("pinned_by"),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.createdAt] }),
    index("dm_messages_thread_created_idx").on(t.threadId, t.createdAt.desc()),
    index("dm_messages_sender_created_idx").on(t.senderId, t.createdAt.desc(), t.id.desc()),
    // Partial pin-list index (0046): only pinned rows are indexed.
    index("dm_messages_thread_pinned_idx")
      .on(t.threadId, t.pinnedAt.desc())
      .where(sql`pinned_at IS NOT NULL`),
  ],
)

export type DmMessageRow = typeof dmMessages.$inferSelect
export type NewDmMessageRow = typeof dmMessages.$inferInsert
