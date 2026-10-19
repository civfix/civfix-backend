/**
 * Automated city filing (0196): where each report was filed and what the city said back. The CHECK
 * value sets live in the hand SQL; their TS mirrors are FILING_*_VALUES in types.ts.
 */

import { sql } from "drizzle-orm"
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { inboundEmails } from "./inbound_emails.js"
import { jurisdictions } from "./jurisdictions.js"
import { mailMessages, mailThreads } from "./mail.js"
import { reports } from "./reports.js"
import { users } from "./users.js"
import type {
  FILING_CHANNEL_VALUES,
  FILING_EVIDENCE_KIND_VALUES,
  FILING_METHOD_VALUES,
  FILING_REASON_VALUES,
  FILING_STATUS_VALUES,
} from "./types.js"

type FilingChannel = (typeof FILING_CHANNEL_VALUES)[number]
type FilingStatus = (typeof FILING_STATUS_VALUES)[number]
type FilingMethod = (typeof FILING_METHOD_VALUES)[number]
type FilingReason = (typeof FILING_REASON_VALUES)[number]
type FilingEvidenceKind = (typeof FILING_EVIDENCE_KIND_VALUES)[number]

export const reportFilings = pgTable(
  "report_filings",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    reportId: uuid("report_id")
      .notNull()
      .references(() => reports.id),
    geoid: text("geoid").references(() => jurisdictions.geoid),
    category: text("category").notNull(),
    routeCategory: text("route_category"),
    channel: text("channel").$type<FilingChannel>(),
    portalHost: text("portal_host"),
    formUrl: text("form_url"),
    status: text("status").$type<FilingStatus>().notNull(),
    method: text("method").$type<FilingMethod>(),
    reason: text("reason").$type<FilingReason>(),
    reasonDetail: text("reason_detail"),
    caseId: text("case_id"),
    caseUrl: text("case_url"),
    cityClosedAt: timestamp("city_closed_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    runId: uuid("run_id"),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    aiWaitSince: timestamp("ai_wait_since", { withTimezone: true }),
    scriptVersion: text("script_version"),
    dryRun: boolean("dry_run").notNull().default(false),
    ticketText: text("ticket_text").notNull(),
    note: text("note"),
    mailThreadId: uuid("mail_thread_id").references(() => mailThreads.id),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("report_filings_active_report_key")
      .on(t.reportId)
      .where(sql`status IN ('queued', 'running', 'needs_human')`),
    index("report_filings_status_updated_idx").on(t.status, t.updatedAt.desc()),
    index("report_filings_report_created_idx").on(t.reportId, t.createdAt.desc()),
    index("report_filings_case_id_idx")
      .on(t.caseId)
      .where(sql`case_id IS NOT NULL`),
    index("report_filings_mail_thread_idx")
      .on(t.mailThreadId)
      .where(sql`mail_thread_id IS NOT NULL`),
    index("report_filings_geoid_route_idx")
      .on(t.geoid, t.routeCategory)
      .where(sql`geoid IS NOT NULL`),
  ],
)

export const filingEvidence = pgTable(
  "filing_evidence",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    filingId: uuid("filing_id")
      .notNull()
      .references(() => reportFilings.id),
    r2Key: text("r2_key").notNull(),
    kind: text("kind").$type<FilingEvidenceKind>().notNull(),
    label: text("label"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("filing_evidence_filing_created_idx").on(t.filingId, t.createdAt)],
)

export const filingRoutes = pgTable(
  "filing_routes",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    geoid: text("geoid")
      .notNull()
      .references(() => jurisdictions.geoid),
    category: text("category"),
    channel: text("channel").$type<FilingChannel>().notNull(),
    formUrl: text("form_url"),
    requestTypeHint: text("request_type_hint"),
    includeLink: boolean("include_link").notNull().default(true),
    statusSenderDomains: text("status_sender_domains")
      .array()
      .notNull()
      .default(sql`'{}'`),
    enabled: boolean("enabled").notNull().default(true),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid("updated_by").references(() => users.id),
  },
  (t) => [
    uniqueIndex("filing_routes_geoid_category_key")
      .on(t.geoid, t.category)
      .where(sql`category IS NOT NULL`),
    uniqueIndex("filing_routes_geoid_default_key")
      .on(t.geoid)
      .where(sql`category IS NULL`),
  ],
)

export const filingSettings = pgTable("filing_settings", {
  id: smallint("id").primaryKey(),
  paused: boolean("paused").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid("updated_by").references(() => users.id),
})

export const filingMessages = pgTable(
  "filing_messages",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    filingId: uuid("filing_id")
      .notNull()
      .references(() => reportFilings.id),
    inboundEmailId: uuid("inbound_email_id").references(() => inboundEmails.id, {
      onDelete: "set null",
    }),
    mailMessageId: uuid("mail_message_id").references(() => mailMessages.id),
    trusted: boolean("trusted").notNull().default(false),
    flagged: boolean("flagged").notNull().default(false),
    classification: jsonb("classification"),
    summary: text("summary"),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("filing_messages_inbound_email_key")
      .on(t.inboundEmailId)
      .where(sql`inbound_email_id IS NOT NULL`),
    uniqueIndex("filing_messages_mail_message_key")
      .on(t.mailMessageId)
      .where(sql`mail_message_id IS NOT NULL`),
    index("filing_messages_filing_created_idx").on(t.filingId, t.createdAt),
  ],
)

export type ReportFilingRow = typeof reportFilings.$inferSelect
export type NewReportFilingRow = typeof reportFilings.$inferInsert
export type FilingEvidenceRow = typeof filingEvidence.$inferSelect
export type FilingRouteRow = typeof filingRoutes.$inferSelect
export type FilingSettingsRow = typeof filingSettings.$inferSelect
export type FilingMessageRow = typeof filingMessages.$inferSelect
