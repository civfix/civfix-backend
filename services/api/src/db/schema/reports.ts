/**
 * reports: a citizen-submitted issue (trash, graffiti, hazard, ...) at a point location.
 *
 * Either `reporter_user_id` (signed-in) or `anon_session_id` (anonymous token) identifies the
 * author; both may be null for system-created rows. `idempotency_key` is a client-supplied UUID with
 * a UNIQUE constraint so a retried submit cannot create duplicates. `geom` is a Point(4326); the
 * GiST index for spatial queries is in 0001_core.sql. `h3_cell` is the H3 index of the point used for
 * clustering + per-cell rate limiting; it is indexed together with created_at for feed queries.
 */

import { sql } from "drizzle-orm"
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
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
    // Fine-grained issue type (0021). Mirrors the shared ReportTypeSchema; coexists with `category`
    // (each type maps to a category via REPORT_TYPE_TO_CATEGORY). text + NOT NULL, same storage approach
    // as `category`. Backfilled for legacy rows from category via a representative inverse map in 0021.
    type: text("type").$type<ReportType>().notNull(),
    title: text("title"),
    description: text("description"),
    // Reverse-geocoded street address for the point (0011). Display label echoed to the operator
    // console (admin report detail); lat/lng (geom) stays canonical. Nullable: clients may omit it.
    addr: text("addr"),
    status: text("status").$type<ReportStatus>().notNull(),
    visibility: text("visibility").$type<ReportVisibility>().notNull().default("public"),
    h3Cell: text("h3_cell").notNull(),
    // Per-report single-use claim code for anonymous reports (0005). Minted at insert, returned in
    // AnonReportResponse, and cleared on claim. Nullable: non-anon reports never carry one. Replaces the
    // prior overwritten anon_tokens.claim_code so EACH report on a token is independently claimable.
    claimCode: text("claim_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  // NOTE: GiST(geom) is in 0001_core.sql. Only b-tree/unique indexes are declared here.
  (t) => [
    uniqueIndex("reports_idempotency_key_key").on(t.idempotencyKey),
    index("reports_jurisdiction_idx").on(t.jurisdictionGeoid),
    index("reports_status_idx").on(t.status),
    index("reports_h3_created_idx").on(t.h3Cell, t.createdAt),
    index("reports_reporter_idx").on(t.reporterUserId),
    index("reports_anon_session_idx").on(t.anonSessionId),
    // Partial unique (WHERE claim_code IS NOT NULL): an active code resolves to exactly one report.
    uniqueIndex("reports_claim_code_key").on(t.claimCode).where(sql`claim_code IS NOT NULL`),
    // --- Performance indexes added in drizzle/0013_perf_indexes.sql ---
    // Admin reports list keyset (created_at DESC, id DESC) over non-deleted rows.
    index("reports_created_id_idx")
      .on(t.createdAt.desc(), t.id.desc())
      .where(sql`deleted_at IS NULL`),
    // Same list with the status facet leading.
    index("reports_status_created_id_idx")
      .on(t.status, t.createdAt.desc(), t.id.desc())
      .where(sql`deleted_at IS NULL`),
    // recentPins + activity report feed: newest public, non-deleted reports.
    index("reports_public_recent_idx")
      .on(t.createdAt.desc())
      .where(sql`deleted_at IS NULL AND visibility = 'public'`),
    // Held-anon release sweep: oldest-first held + anon + non-deleted reports.
    index("reports_held_anon_created_idx")
      .on(t.createdAt)
      .where(sql`status = 'held' AND reporter_user_id IS NULL AND deleted_at IS NULL`),
    // NOTE: a trigram GIN index `reports_title_trgm ON reports USING gin (title gin_trgm_ops)`
    // for the admin `title ILIKE '%q%'` search lives in drizzle/0014_search_trgm.sql. It is
    // intentionally NOT mirrored here: it only backs raw-SQL ILIKE searches and the gin_trgm_ops
    // opclass form is not worth the brittle Drizzle expression.
  ],
)

export type ReportRow = typeof reports.$inferSelect
export type NewReportRow = typeof reports.$inferInsert
