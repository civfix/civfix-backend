/**
 * Onboarding work items, created when a report lands in an area civfix does not yet route. A partial
 * UNIQUE(geoid) WHERE status <> 'done' (0001_core.sql, SQL-only) prevents two concurrent open tasks for
 * one geoid while keeping historical done rows.
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
  (t) => [index("jurisdiction_discovery_status_pop_idx").on(t.status, t.population.desc())],
)

export type JurisdictionDiscoveryTaskRow = typeof jurisdictionDiscoveryTasks.$inferSelect
export type NewJurisdictionDiscoveryTaskRow = typeof jurisdictionDiscoveryTasks.$inferInsert
