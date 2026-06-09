/**
 * Inbound emails (catch-all): non-reply *@civfix.org mail triaged in the admin Inbox. Reply mail still
 * lives in mail_threads/mail_messages; this is the lightweight store for everything else.
 *
 * message_id is UNIQUE (the dedup key — RFC822 Message-ID or a derived hash). attachments jsonb is an
 * array of { key (R2), filename, size }, same shape as mail_messages.attachments.
 *
 * CANONICAL DDL: drizzle/0010_inbound_emails.sql. This mirror exists for typed queries / diff inspection.
 */

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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("inbound_emails_message_id_key").on(t.messageId),
    index("inbound_emails_received_idx").on(t.receivedAt.desc(), t.id.desc()),
    index("inbound_emails_status_received_idx").on(t.status, t.receivedAt.desc(), t.id.desc()),
    index("inbound_emails_recipient_idx").on(t.recipient),
  ],
)

export type InboundEmailRow = typeof inboundEmails.$inferSelect
export type NewInboundEmailRow = typeof inboundEmails.$inferInsert
