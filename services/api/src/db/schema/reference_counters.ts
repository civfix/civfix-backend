/**
 * reference_counters: per-scope monotonic counter backing the human-readable reference codes minted on
 * reports + cleanups (issue #56). One row per scope_key; `next_val` is the last allocated value.
 *
 * scope_key shape: "{typecode}:{jurcode}" for reports (e.g. "DU:42") and "EVENT:{jurcode}" for events.
 * Allocation is a single atomic upsert (INSERT ... ON CONFLICT (scope_key) DO UPDATE SET next_val =
 * next_val + 1 RETURNING next_val), so the live create paths and the post-deploy backfill share one
 * counter and can never mint a colliding code. See src/db/reference-code.ts for the allocator + formatter.
 *
 * CANONICAL DDL: drizzle/0030_reference_codes.sql. This mirror exists for typed queries / diff inspection.
 */

import { bigint, pgTable, text } from "drizzle-orm/pg-core"

export const referenceCounters = pgTable("reference_counters", {
  scopeKey: text("scope_key").primaryKey(),
  // bigint stored as number: report/event counts per scope stay far below 2^53, so the JS `number`
  // mode is exact here (matches how allocateNextSeq returns a JS number).
  nextVal: bigint("next_val", { mode: "number" }).notNull(),
})

export type ReferenceCounterRow = typeof referenceCounters.$inferSelect
export type NewReferenceCounterRow = typeof referenceCounters.$inferInsert
