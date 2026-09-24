import type { Queryable } from "../db/client.js"

/**
 * A plain SELECT that takes no row lock, so it cannot disturb the allocator's lock order wherever it is
 * called.
 */
export async function jurisdictionCodeIn(q: Queryable, geoid: string): Promise<number | null> {
  const rows = await q<{ code: number | null }[]>`
    SELECT code FROM jurisdictions WHERE geoid = ${geoid} LIMIT 1
  `
  return rows[0]?.code ?? null
}

/** Must be the FIRST statement of the create transaction (lock-order contract in db/reference-code.ts). */
export async function allocateNextSeqIn(q: Queryable, scopeKey: string): Promise<number> {
  const rows = await q<{ next_val: number }[]>`
    INSERT INTO reference_counters (scope_key, next_val)
    VALUES (${scopeKey}, 1)
    ON CONFLICT (scope_key) DO UPDATE
      SET next_val = reference_counters.next_val + 1
    RETURNING next_val
  `
  return Number(rows[0]!.next_val)
}
