import { explainPressing, PRESSING_INDEX } from "../../src/services/report-repository.drizzle.js"
import type { PgHarness } from "./pg.js"

type BBox = Parameters<typeof explainPressing>[1]

// Build it before the suite writes a row, as production built it out of band before the list mattered.
// An index created over HOT-updated rows is marked indcheckxmin, and a transaction whose snapshot predates
// it cannot use it, which made the plan assertions pick another index (or a seq scan) at random.
export async function createPressingIndex(sql: PgHarness["sql"]): Promise<void> {
  await sql`
    CREATE INDEX IF NOT EXISTS reports_pressing_idx
      ON reports (confirm_count DESC, created_at DESC)
      WHERE confirm_count >= 1 AND visibility = 'public' AND deleted_at IS NULL
  `
}

// The plan of the pressing query with every other droppable reports index dropped in a rolled-back
// transaction: on a test-sized table several are about as cheap, so this leaves only the question the
// assertions ask, whether the query's WHERE still implies the pressing predicate.
export async function explainPressingAlone(sql: PgHarness["sql"], bbox: BBox): Promise<string> {
  const rollback = new Error("rollback")
  let plan = ""
  await sql
    .begin(async (tx) => {
      const others = await tx<{ relname: string }[]>`
        SELECT c.relname
        FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
        WHERE i.indrelid = 'reports'::regclass
          AND c.relname <> ${PRESSING_INDEX}
          AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = i.indexrelid)
      `
      for (const { relname } of others) await tx`DROP INDEX ${tx(relname)}`
      await tx`ANALYZE reports`
      await tx`SET LOCAL enable_seqscan = off`
      await tx`SET LOCAL enable_bitmapscan = off`
      plan = await explainPressing(tx, bbox, 20)
      throw rollback
    })
    .catch((err: unknown) => {
      if (err !== rollback) throw err
    })
  return plan
}
