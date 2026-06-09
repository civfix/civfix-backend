/**
 * jurisdictions: government boundaries used to route reports to the responsible authority.
 *
 * Keyed by `geoid` (Census GEOID string). `layer` is one of place|county|state; `priority` orders
 * overlapping layers so the most specific authority wins (place < county < state). `geom` is a
 * MultiPolygon(4326) covering the area; the GiST index that makes ST_Contains fast is created in the
 * hand SQL (0001_core.sql), not here, because drizzle-kit cannot emit GiST.
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
    geom: geometry("geom", { subtype: "MultiPolygon", srid: 4326 }).notNull(),
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
  ],
)

export type JurisdictionRow = typeof jurisdictions.$inferSelect
export type NewJurisdictionRow = typeof jurisdictions.$inferInsert
