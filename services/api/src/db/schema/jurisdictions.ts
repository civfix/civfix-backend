/**
 * jurisdictions: government boundaries used to route reports to the responsible authority.
 *
 * Keyed by `geoid` (Census GEOID string). `layer` is one of place|county|state; `priority` orders
 * overlapping layers so the most specific authority wins (place < county < state). `geom` is the
 * MultiPolygon(4326) covering the area FOR INGESTED ROWS; the GiST index that makes ST_Contains fast is
 * created in the hand SQL (0001_core.sql), not here, because drizzle-kit cannot emit GiST.
 *
 * geom is NULLABLE (0015_jurisdiction_geom_nullable.sql): the write-time Census fallback lazily upserts
 * API-sourced rows that carry geoid + name + layer but NO polygon (the Census Geographies API returns an
 * identity, not a boundary — see src/adapters/jurisdiction-lookup.census.ts). A NULL-geom row never matches
 * ST_Contains (so the GiST index + resolver ranking are unaffected) and is only ever read by its own geoid.
 *
 * contact_emails / report_form_url / notes / contact_updated_at hold the outreach + routing metadata
 * the discovery pipeline fills in.
 */

import { index, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core"
import { geometry, type JURISDICTION_LAYER_VALUES } from "./types.js"

type JurisdictionLayer = (typeof JURISDICTION_LAYER_VALUES)[number]

export const jurisdictions = pgTable(
  "jurisdictions",
  {
    geoid: text("geoid").primaryKey(),
    name: text("name").notNull(),
    layer: text("layer").$type<JurisdictionLayer>().notNull(),
    priority: integer("priority").notNull(),
    // NULLABLE (DDL source of truth: drizzle/0015_jurisdiction_geom_nullable.sql). Ingested boundary rows
    // carry a polygon; lazily API-sourced rows (write-time Census fallback) have geoid+name but geom = NULL.
    geom: geometry("geom", { subtype: "MultiPolygon", srid: 4326 }),
    population: integer("population"),
    contactEmails: text("contact_emails").array(),
    reportFormUrl: text("report_form_url"),
    notes: text("notes"),
    contactUpdatedAt: timestamp("contact_updated_at", { withTimezone: true }),
    // Operator "flag for review" state (0012). Nullable; purely advisory (does not affect resolution).
    flaggedAt: timestamp("flagged_at", { withTimezone: true }),
    flagReason: text("flag_reason"),
    // The @handle used to mention this jurisdiction in a report discussion, e.g. "@sf" (0017).
    // Nullable; most jurisdictions have no handle. A PARTIAL UNIQUE index on lower(handle) keeps
    // handles case-insensitively unique (see NOTE below).
    handle: text("handle"),
    // Compact integer code used as the JURCODE segment of report/event reference codes (0030, D2).
    // Allocated from jurisdiction_code_seq (single source of truth): backfilled by geoid ordinal in
    // 0030, and via nextval() for lazily-upserted rows. NULLABLE in the mirror; all rows are backfilled.
    code: integer("code"),
  },
  // NOTE: the GiST(geom) index lives in 0001_core.sql. Only b-tree indexes are declared here.
  (t) => [
    index("jurisdictions_layer_idx").on(t.layer),
    index("jurisdictions_population_idx").on(t.population),
    // UNIQUE jurisdiction code (0030). Tolerates NULLs; here all rows are backfilled.
    uniqueIndex("jurisdictions_code_uidx").on(t.code),
    // NOTE: a trigram GIN index `jurisdictions_name_trgm ON jurisdictions USING gin (name gin_trgm_ops)`
    // backs the admin reports `j.name ILIKE '%q%'` search. It lives in drizzle/0014_search_trgm.sql and
    // is intentionally NOT mirrored here (raw-SQL-only search; gin_trgm_ops opclass form).
    // NOTE: a partial UNIQUE index `jurisdictions_handle_lower_key ON jurisdictions (lower(handle))
    // WHERE handle IS NOT NULL` enforces case-insensitive handle uniqueness. It lives in
    // drizzle/0017_report_discussion.sql and is intentionally NOT mirrored here (the lower() functional
    // expression + partial predicate is not worth the brittle Drizzle expression).
  ],
)

export type JurisdictionRow = typeof jurisdictions.$inferSelect
export type NewJurisdictionRow = typeof jurisdictions.$inferInsert
