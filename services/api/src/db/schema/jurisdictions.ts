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

import { index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core"
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
  },
  // NOTE: the GiST(geom) index lives in 0001_core.sql. Only b-tree indexes are declared here.
  (t) => [
    index("jurisdictions_layer_idx").on(t.layer),
    index("jurisdictions_population_idx").on(t.population),
    // NOTE: a trigram GIN index `jurisdictions_name_trgm ON jurisdictions USING gin (name gin_trgm_ops)`
    // backs the admin reports `j.name ILIKE '%q%'` search. It lives in drizzle/0014_search_trgm.sql and
    // is intentionally NOT mirrored here (raw-SQL-only search; gin_trgm_ops opclass form).
  ],
)

export type JurisdictionRow = typeof jurisdictions.$inferSelect
export type NewJurisdictionRow = typeof jurisdictions.$inferInsert
