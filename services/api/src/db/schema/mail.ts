import { sql } from "drizzle-orm"
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { cleanups } from "./cleanups.js"
import { jurisdictions } from "./jurisdictions.js"
import { reports } from "./reports.js"
import type {
  MAIL_DIRECTION_VALUES,
  MAIL_EVENT_TYPE_VALUES,
  MAIL_THREAD_STATUS_VALUES,
} from "./types.js"

type MailThreadStatus = (typeof MAIL_THREAD_STATUS_VALUES)[number]
type MailDirection = (typeof MAIL_DIRECTION_VALUES)[number]
type MailEventType = (typeof MAIL_EVENT_TYPE_VALUES)[number]

export const mailThreads = pgTable(
  "mail_threads",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    threadToken: text("thread_token").notNull(),
    jurisdictionGeoid: text("jurisdiction_geoid").references(() => jurisdictions.geoid),
    reportId: uuid("report_id").references(() => reports.id, { onDelete: "set null" }),
    cleanupId: uuid("cleanup_id").references(() => cleanups.id, { onDelete: "set null" }),
    org: text("org"),
    subject: text("subject"),
    status: text("status").$type<MailThreadStatus>().notNull().default("sent"),
    unread: boolean("unread").notNull().default(false),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("mail_threads_thread_token_key").on(t.threadToken),
    index("mail_threads_status_idx").on(t.status),
    index("mail_threads_geoid_idx").on(t.jurisdictionGeoid),
    index("mail_threads_last_message_idx").on(t.lastMessageAt.desc()),
    index("mail_threads_unread_idx")
      .on(t.lastMessageAt.desc())
      .where(sql`${t.unread} = true`),
  ],
)

export const mailMessages = pgTable(
  "mail_messages",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => mailThreads.id, { onDelete: "cascade" }),
    direction: text("direction").$type<MailDirection>().notNull(),
    fromAddr: text("from_addr"),
    toAddr: text("to_addr"),
    subject: text("subject"),
    body: text("body"),
    html: text("html"),
    kind: text("kind"),
    attachments: jsonb("attachments").notNull().default([]),
    messageId: text("message_id"),
    inReplyTo: text("in_reply_to"),
    unaffiliated: boolean("unaffiliated").notNull().default(false),
    effectsClaimedAt: timestamp("effects_claimed_at", { withTimezone: true }),
    effectsAppliedAt: timestamp("effects_applied_at", { withTimezone: true }),
    effectsStage: integer("effects_stage").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("mail_messages_thread_created_idx").on(t.threadId, t.createdAt),
    index("mail_messages_effects_pending_idx")
      .on(t.createdAt)
      .where(sql`direction = 'in' AND unaffiliated = false AND effects_applied_at IS NULL`),
    index("mail_messages_message_id_idx")
      .on(t.messageId)
      .where(sql`message_id IS NOT NULL`),
    uniqueIndex("mail_messages_message_id_uk")
      .on(t.messageId)
      .where(sql`message_id IS NOT NULL`),
  ],
)

export const mailEvents = pgTable(
  "mail_events",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    threadId: uuid("thread_id").references(() => mailThreads.id, { onDelete: "set null" }),
    messageId: text("message_id"),
    type: text("type").$type<MailEventType>().notNull(),
    meta: jsonb("meta").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("mail_events_type_created_idx").on(t.type, t.createdAt.desc()),
    index("mail_events_thread_idx").on(t.threadId),
    index("mail_events_created_idx").on(t.createdAt.desc()),
    index("mail_events_bounced_recipient_idx")
      .on(sql`lower(${t.meta} ->> 'failedRecipient')`)
      .where(sql`${t.type} = 'bounced'`),
  ],
)

export type MailThreadRow = typeof mailThreads.$inferSelect
export type NewMailThreadRow = typeof mailThreads.$inferInsert
export type MailMessageRow = typeof mailMessages.$inferSelect
export type NewMailMessageRow = typeof mailMessages.$inferInsert
export type MailEventRow = typeof mailEvents.$inferSelect
export type NewMailEventRow = typeof mailEvents.$inferInsert
