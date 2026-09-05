
import { R2_PUT_TTL_SEC } from "../adapters/storage.r2.js"
import type { Sql } from "./client.js"
import { runDbCli, runIfMain } from "./cli.js"

const DEFAULT_BATCH_SIZE = 1000

export interface BackfillServedKeyResult {
  adopted: number
  skippedInsidePutWindow: number
}

export async function backfillServedKeys(
  sql: Sql,
  opts: { batchSize?: number } = {},
): Promise<BackfillServedKeyResult> {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE
  let adopted = 0
  let cursor: string | null = null

  for (;;) {
    const page: { id: string }[] = await sql<{ id: string }[]>`
      SELECT id
      FROM media_assets
      WHERE status = 'ready'
        AND served_key IS NULL
        ${cursor === null ? sql`` : sql`AND id > ${cursor}`}
      ORDER BY id
      LIMIT ${batchSize}
    `
    if (page.length === 0) break

    const updated = await sql<{ id: string }[]>`
      UPDATE media_assets
      SET served_key = r2_key
      WHERE id IN ${sql(page.map((r) => r.id))}
        AND status = 'ready'
        AND served_key IS NULL
        AND created_at < now() - make_interval(secs => ${R2_PUT_TTL_SEC})
      RETURNING id
    `
    adopted += updated.length
    cursor = page[page.length - 1]!.id
    console.log(
      `backfill-served-key: page of ${page.length} (adopted ${updated.length}); running total ${adopted}`,
    )
  }

  const remaining = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n
    FROM media_assets
    WHERE status = 'ready' AND served_key IS NULL
  `
  const skippedInsidePutWindow = remaining[0]?.n ?? 0
  if (skippedInsidePutWindow > 0) {
    console.log(
      `backfill-served-key: ${skippedInsidePutWindow} ready row(s) are still inside the presigned-PUT ` +
        `window (${R2_PUT_TTL_SEC}s) and were left NULL on purpose - re-run this backfill after the ` +
        "window passes to adopt them",
    )
  }
  return { adopted, skippedInsidePutWindow }
}

runIfMain(import.meta.url, "backfill-served-key", async () => {
  await runDbCli(async (_db, sql) => {
    const result = await backfillServedKeys(sql)
    console.log("backfill-served-key: done", result)
  })
})
