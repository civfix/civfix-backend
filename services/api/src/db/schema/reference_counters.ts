/**
 * Per-scope counter behind reference codes; `next_val` is the last allocated value. scope_key is
 * "{typecode}:{jurcode}" for reports (e.g. "DU:42") and "EVENT:{jurcode}" for events. Allocation is one
 * atomic upsert (see reference-code.ts), so the live create paths and the backfill share one counter and
 * can never mint a colliding code.
 */

import { bigint, pgTable, text } from "drizzle-orm/pg-core"

export const referenceCounters = pgTable("reference_counters", {
  scopeKey: text("scope_key").primaryKey(),
  // Number mode is exact: per-scope counts stay far below 2^53.
  nextVal: bigint("next_val", { mode: "number" }).notNull(),
})

export type ReferenceCounterRow = typeof referenceCounters.$inferSelect
export type NewReferenceCounterRow = typeof referenceCounters.$inferInsert
