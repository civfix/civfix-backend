/**
 * boundary_vintage: single-row tracker for the active jurisdiction-boundary dataset loaded by the
 * automated `jurisdiction.refresh` cron (src/services/admin/boundary-refresh-jobs.ts). Canonical DDL:
 * drizzle/0028_boundary_vintage.sql.
 *
 * Mirrors the hand-authored DDL for typed queries + drizzle-kit diff inspection only (the cron itself
 * reads/writes this row through raw `sql` like the other db/* scripts). The singleton CHECK (id) and the
 * jsonb default live in the SQL (drizzle-kit cannot model the CHECK), so they are NOT re-declared here.
 */

import { boolean, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core"

export const boundaryVintage = pgTable("boundary_vintage", {
  // Singleton primary key (always true). The CHECK (id) enforcing exactly one row lives in the DDL.
  id: boolean("id").primaryKey().default(true),
  vintageTag: text("vintage_tag").notNull(),
  tigerVintage: integer("tiger_vintage").notNull(),
  padusVersion: text("padus_version").notNull(),
  loadedAt: timestamp("loaded_at", { withTimezone: true }).notNull().defaultNow(),
  rowCounts: jsonb("row_counts").notNull().default({}),
})

export type BoundaryVintageRow = typeof boundaryVintage.$inferSelect
export type NewBoundaryVintageRow = typeof boundaryVintage.$inferInsert
