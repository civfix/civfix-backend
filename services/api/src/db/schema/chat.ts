/**
 * chat_messages: messages in a cleanup's chat thread.
 *
 * IMPORTANT: in Postgres this table is DECLARATIVELY PARTITIONED BY RANGE (created_at) into monthly
 * partitions (see 0002_chat_partitioning.sql). A partitioned table's primary key must include the
 * partition key, so the PK is composite PK(id, created_at) rather than just id. The Drizzle
 * definition below models the columns and that composite PK purely so query builders work; the
 * partition structure itself is owned by the hand SQL.
 *
 * `attachments` is jsonb (array of attachment descriptors). `kind` defaults to 'text'. `edited_at` /
 * `deleted_at` support edit + soft-delete. The (cleanup_id, created_at DESC) index serves history
 * pagination and is declared on the parent table in the SQL migration (it propagates to partitions).
 */

import { sql } from "drizzle-orm"
import { index, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { cleanups } from "./cleanups.js"
import { users } from "./users.js"
import type { CHAT_MESSAGE_KIND_VALUES } from "./types.js"

type ChatMessageKind = (typeof CHAT_MESSAGE_KIND_VALUES)[number]

export const chatMessages = pgTable(
  "chat_messages",
  {
    // Not marked .primaryKey() at the column level: the PK is the composite below (partition key
    // must be part of the PK). gen_random_uuid() default still applies for inserts.
    id: uuid("id")
      .notNull()
      .default(sql`gen_random_uuid()`),
    cleanupId: uuid("cleanup_id")
      .notNull()
      .references(() => cleanups.id),
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
    // Composite PK including the partition key (created_at). Matches 0002_chat_partitioning.sql.
    primaryKey({ columns: [t.id, t.createdAt] }),
    // Declared on the parent in SQL; mirrored here for query planning/introspection parity.
    index("chat_messages_cleanup_created_idx").on(t.cleanupId, t.createdAt.desc()),
  ],
)

export type ChatMessageRow = typeof chatMessages.$inferSelect
export type NewChatMessageRow = typeof chatMessages.$inferInsert
