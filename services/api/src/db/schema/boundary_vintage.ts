/**
 * Single-row record of the active boundary dataset, stamped by scripts/refresh-boundaries.ts after each
 * nationwide load. The singleton CHECK (id) lives only in 0028_boundary_vintage.sql because drizzle-kit
 * cannot model it.
 */

import { boolean, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core"

export const boundaryVintage = pgTable("boundary_vintage", {
  id: boolean("id").primaryKey().default(true),
  vintageTag: text("vintage_tag").notNull(),
  tigerVintage: integer("tiger_vintage").notNull(),
  padusVersion: text("padus_version").notNull(),
  loadedAt: timestamp("loaded_at", { withTimezone: true }).notNull().defaultNow(),
  rowCounts: jsonb("row_counts").notNull().default({}),
})

export type BoundaryVintageRow = typeof boundaryVintage.$inferSelect
export type NewBoundaryVintageRow = typeof boundaryVintage.$inferInsert
