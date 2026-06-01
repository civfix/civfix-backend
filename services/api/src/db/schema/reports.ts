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
  type REPORT_VISIBILITY_VALUES,
} from "./types.js"

type ReportCategory = (typeof REPORT_CATEGORY_VALUES)[number]
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
    title: text("title"),
    description: text("description"),
    status: text("status").$type<ReportStatus>().notNull(),
    visibility: text("visibility").$type<ReportVisibility>().notNull().default("public"),
    h3Cell: text("h3_cell").notNull(),
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
  ],
)

export type ReportRow = typeof reports.$inferSelect
export type NewReportRow = typeof reports.$inferInsert
