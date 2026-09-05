
import { sql } from "drizzle-orm"
import { boolean, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import type { INBOUND_EMAIL_STATUS_VALUES } from "./types.js"

type InboundEmailStatus = (typeof INBOUND_EMAIL_STATUS_VALUES)[number]

export const inboundEmails = pgTable(
  "inbound_emails",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    messageId: text("message_id").notNull(),
    fromAddr: text("from_addr"),
    toAddr: text("to_addr"),
    recipient: text("recipient"),
    subject: text("subject"),
    bodyText: text("body_text"),
    bodyHtml: text("body_html"),
    headers: jsonb("headers").notNull().default({}),
    attachments: jsonb("attachments").notNull().default([]),
    hasAttachments: boolean("has_attachments").notNull().default(false),
    status: text("status").$type<InboundEmailStatus>().notNull().default("unread"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("inbound_emails_message_id_key").on(t.messageId),
    index("inbound_emails_received_idx").on(t.receivedAt.desc(), t.id.desc()),
    index("inbound_emails_status_received_idx").on(t.status, t.receivedAt.desc(), t.id.desc()),
    index("inbound_emails_recipient_idx").on(t.recipient),
    index("inbound_emails_archived_at_idx")
      .on(t.archivedAt)
      .where(sql`archived_at IS NOT NULL`),
  ],
)

export type InboundEmailRow = typeof inboundEmails.$inferSelect
export type NewInboundEmailRow = typeof inboundEmails.$inferInsert
