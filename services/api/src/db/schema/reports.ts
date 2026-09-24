import { sql } from "drizzle-orm"
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import type { AddressPrecision, ReportAddressSource } from "@civfix/shared"
import { jurisdictions } from "./jurisdictions.js"
import { users } from "./users.js"
import {
  geometry,
  type GEOM_SOURCE_VALUES,
  type REPORT_CATEGORY_VALUES,
  type REPORT_STATUS_VALUES,
  type REPORT_TYPE_VALUES,
  type REPORT_VISIBILITY_VALUES,
} from "./types.js"

type ReportCategory = (typeof REPORT_CATEGORY_VALUES)[number]
type ReportType = (typeof REPORT_TYPE_VALUES)[number]
type ReportStatus = (typeof REPORT_STATUS_VALUES)[number]
type GeomSource = (typeof GEOM_SOURCE_VALUES)[number]
type ReportVisibility = (typeof REPORT_VISIBILITY_VALUES)[number]

export const reports = pgTable(
  "reports",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    reporterUserId: uuid("reporter_user_id").references(() => users.id),
    anonSessionId: text("anon_session_id"),
    idempotencyKey: uuid("idempotency_key").notNull(),
    geom: geometry("geom", { subtype: "Point", srid: 4326 }).notNull(),
    geomSource: text("geom_source").$type<GeomSource>().notNull(),
    jurisdictionGeoid: text("jurisdiction_geoid").references(() => jurisdictions.geoid),
    category: text("category").$type<ReportCategory>().notNull(),
    type: text("type").$type<ReportType>().notNull(),
    title: text("title"),
    description: text("description"),
    addr: text("addr"),
    addrSource: text("addr_source").$type<ReportAddressSource>(),
    /** Always NULL when addrSource is 'user': only a resolved address has a precision. */
    addrPrecision: text("addr_precision").$type<AddressPrecision>(),
    status: text("status").$type<ReportStatus>().notNull(),
    visibility: text("visibility").$type<ReportVisibility>().notNull().default("public"),
    h3Cell: text("h3_cell").notNull(),
    /** Dead: never written since 0091. The DROP is deferred one release. */
    claimCode: text("claim_code"),
    /** The only claim secret at rest: a SHA-256 hex, never the code itself. */
    claimCodeHash: text("claim_code_hash"),
    referenceCode: text("reference_code"),
    verificationVerdict: text("verification_verdict").$type<"approved" | "rejected">(),
    verifiedBy: uuid("verified_by").references(() => users.id),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    holdReleaseCheckedAt: timestamp("hold_release_checked_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("reports_idempotency_key_key").on(t.idempotencyKey),
    index("reports_jurisdiction_idx").on(t.jurisdictionGeoid),
    index("reports_status_idx").on(t.status),
    index("reports_h3_created_idx").on(t.h3Cell, t.createdAt),
    index("reports_reporter_idx").on(t.reporterUserId),
    index("reports_reporter_created_idx")
      .on(t.reporterUserId, t.createdAt)
      .where(sql`reporter_user_id IS NOT NULL`),
    index("reports_anon_session_idx").on(t.anonSessionId),
    uniqueIndex("reports_claim_code_key")
      .on(t.claimCode)
      .where(sql`claim_code IS NOT NULL`),
    uniqueIndex("reports_claim_code_hash_key")
      .on(t.claimCodeHash)
      .where(sql`claim_code_hash IS NOT NULL`),
    uniqueIndex("reports_reference_code_uidx").on(t.referenceCode),
    index("reports_created_id_idx")
      .on(t.createdAt.desc(), t.id.desc())
      .where(sql`deleted_at IS NULL`),
    index("reports_status_created_id_idx")
      .on(t.status, t.createdAt.desc(), t.id.desc())
      .where(sql`deleted_at IS NULL`),
    index("reports_public_recent_idx")
      .on(t.createdAt.desc())
      .where(sql`deleted_at IS NULL AND visibility = 'public'`),
    index("reports_held_anon_created_idx")
      .on(t.createdAt)
      .where(sql`status = 'held' AND reporter_user_id IS NULL AND deleted_at IS NULL`),
    check(
      "reports_status_chk",
      sql`${t.status} IN ('submitted', 'held', 'published', 'acknowledged', 'in_progress', 'resolved', 'rejected')`,
    ),
  ],
)

export type ReportRow = typeof reports.$inferSelect
export type NewReportRow = typeof reports.$inferInsert
