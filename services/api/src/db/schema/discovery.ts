/**
 * jurisdiction_discovery_tasks: work items for onboarding a new government jurisdiction (finding
 * contact info / report form). Created when a report lands in an area civfix does not yet route.
 *
 * `place_geojson` holds the candidate boundary; `sample_report_id` links the report that triggered
 * discovery. `status` defaults to 'open'; an operator may be assigned. Indexed by (status,
 * population DESC) so the highest-impact open tasks surface first. A PARTIAL UNIQUE on geoid WHERE
 * status <> 'done' (created in 0001_core.sql) prevents two concurrent open tasks for the same geoid
 * while still allowing historical done rows.
 */

import { sql } from "drizzle-orm"
import { index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { reports } from "./reports.js"
import { users } from "./users.js"
import type { DISCOVERY_STATUS_VALUES } from "./types.js"

type DiscoveryStatus = (typeof DISCOVERY_STATUS_VALUES)[number]

export const jurisdictionDiscoveryTasks = pgTable(
  "jurisdiction_discovery_tasks",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    geoid: text("geoid"),
    placeGeojson: jsonb("place_geojson"),
    sampleReportId: uuid("sample_report_id").references(() => reports.id),
    population: integer("population"),
    status: text("status").$type<DiscoveryStatus>().notNull().default("open"),
    assignedOperatorId: uuid("assigned_operator_id").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  // NOTE: the partial UNIQUE(geoid) WHERE status <> 'done' lives in 0001_core.sql.
  (t) => [index("jurisdiction_discovery_status_pop_idx").on(t.status, t.population.desc())],
)

export type JurisdictionDiscoveryTaskRow = typeof jurisdictionDiscoveryTasks.$inferSelect
export type NewJurisdictionDiscoveryTaskRow = typeof jurisdictionDiscoveryTasks.$inferInsert
