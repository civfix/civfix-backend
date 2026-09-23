/**
 * Government boundaries used to route reports to the responsible authority. `priority` orders
 * overlapping layers so the most specific authority wins (place < county < state). The GiST index on
 * geom lives in 0001_core.sql because drizzle-kit cannot emit GiST.
 *
 * geom is nullable (0015): the write-time Census fallback upserts rows with geoid + name + layer but no
 * polygon, because the Census Geographies API returns an identity, not a boundary. A NULL-geom row never
 * matches ST_Contains and is only ever read by its own geoid.
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
    geom: geometry("geom", { subtype: "MultiPolygon", srid: 4326 }),
    population: integer("population"),
    contactEmails: text("contact_emails").array(),
    reportFormUrl: text("report_form_url"),
    notes: text("notes"),
    // NULL uses the built-in default packet (mail-format.ts buildReportPacket). The length bounds are
    // enforced app-side by the shared PatchJurisdictionRequest schema, not by the column.
    forwardSubjectTemplate: text("forward_subject_template"),
    forwardBodyTemplate: text("forward_body_template"),
    contactUpdatedAt: timestamp("contact_updated_at", { withTimezone: true }),
    // Purely advisory: the flag never affects jurisdiction resolution.
    flaggedAt: timestamp("flagged_at", { withTimezone: true }),
    flagReason: text("flag_reason"),
    handle: text("handle"),
    // The JURCODE segment of reference codes, allocated from jurisdiction_code_seq. Nullable in the
    // mirror only: every row is backfilled (0030) or gets nextval() on its lazy upsert.
    code: integer("code"),
  },
  (t) => [
    index("jurisdictions_layer_idx").on(t.layer),
    index("jurisdictions_population_idx").on(t.population),
    uniqueIndex("jurisdictions_code_uidx").on(t.code),
    // Two indexes are SQL-only because Drizzle cannot express them cleanly: the trigram GIN
    // jurisdictions_name_trgm behind the admin name search (0014_search_trgm.sql), and the partial unique
    // jurisdictions_handle_lower_key on lower(handle) that keeps handles case-insensitively unique
    // (0017_report_discussion.sql).
  ],
)

export type JurisdictionRow = typeof jurisdictions.$inferSelect
export type NewJurisdictionRow = typeof jurisdictions.$inferInsert
