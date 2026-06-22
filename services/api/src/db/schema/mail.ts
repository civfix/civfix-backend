/**
 * Mail (Phase 2): two-way mail with municipal contacts (outreach + replies) plus the OCI delivery event
 * feed — mail_threads, mail_messages, mail_events.
 *
 * GOTCHAS: mail_threads.thread_token is the per-thread routing key — the outbound From is
 * {kind}-{token}@{MAIL_REPLY_DOMAIN} (kind = report/event/reply by thread type) and the token is globally
 * UNIQUE (it routes an inbound reply back to the thread). mail_events.thread_id / message_id are nullable
 * because a delivery event can arrive before it is correlated to a thread/message.
 *
 * The status / direction / type CHECKs are enforced in 0007_admin_phase2.sql.
 *
 * CANONICAL DDL: drizzle/0007_admin_phase2.sql. This mirror exists for typed queries / diff inspection.
 */

import { sql } from "drizzle-orm"
import {
  boolean,
  index,
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
    // Per-report outreach thread linkage (0020): the report this thread carries the conversation for, so
    // a jurisdiction's reply auto-routes back onto it. Nullable: digest/compose threads have no report.
    reportId: uuid("report_id").references(() => reports.id, { onDelete: "set null" }),
    // Per-event outreach thread linkage (0031, D10/D19): the cleanup (event) this resource-request thread
    // carries the conversation for, so a city reply auto-routes back onto it. Nullable: report/digest
    // threads have no cleanup. Mirrors reportId.
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
    // NOTE: the partial index `mail_threads_report_idx ON mail_threads (report_id) WHERE report_id IS
    // NOT NULL` lives ONLY in drizzle/0020_report_mail_link.sql (drizzle-kit cannot emit the partial
    // WHERE predicate), so it is intentionally not mirrored here. Likewise the partial index
    // `mail_threads_cleanup_idx ON mail_threads (cleanup_id) WHERE cleanup_id IS NOT NULL` lives only in
    // drizzle/0031_timeline_event_mail.sql and is intentionally not mirrored here for the same reason.
    index("mail_threads_last_message_idx").on(t.lastMessageAt.desc()),
    index("mail_threads_unread_idx")
      .on(t.lastMessageAt.desc())
      .where(sql`${t.unread} = true`),
    // NOTE: the inbox keyset index `mail_threads_inbox_keyset_idx ON mail_threads
    // ((COALESCE(last_message_at, created_at)) DESC, id DESC)` lives in drizzle/0013_perf_indexes.sql.
    // It is an EXPRESSION index over COALESCE(...) which Drizzle cannot cleanly express, so it is
    // intentionally not mirrored here.
    // NOTE: trigram GIN indexes `mail_threads_org_trgm` / `mail_threads_subject_trgm`
    // (USING gin (... gin_trgm_ops)) back the inbox ILIKE search and live in
    // drizzle/0014_search_trgm.sql; not mirrored here (raw-SQL-only search).
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
    attachments: jsonb("attachments").notNull().default([]),
    messageId: text("message_id"),
    inReplyTo: text("in_reply_to"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("mail_messages_thread_created_idx").on(t.threadId, t.createdAt),
    index("mail_messages_message_id_idx")
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
    // Activity-feed mail_events branch: global newest-first scan. Added in drizzle/0013_perf_indexes.sql.
    index("mail_events_created_idx").on(t.createdAt.desc()),
  ],
)

export type MailThreadRow = typeof mailThreads.$inferSelect
export type NewMailThreadRow = typeof mailThreads.$inferInsert
export type MailMessageRow = typeof mailMessages.$inferSelect
export type NewMailMessageRow = typeof mailMessages.$inferInsert
export type MailEventRow = typeof mailEvents.$inferSelect
export type NewMailEventRow = typeof mailEvents.$inferInsert
