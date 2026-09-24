/**
 * media_assets.upload_etag against a live PostGIS database (Docker-gated; SKIPS without Docker).
 *
 * Finalize stores the HEAD etag in the same UPDATE that claims finalized_at, and the stuck sweep reads
 * it back, so a requeued media.checks job keeps the overwrite check. Rows finalized before the column
 * existed stay NULL and requeue with no etag, as before.
 */

import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { makeDrizzleMediaRepository } from "../../src/services/media-repository.drizzle.js"
import { makeDrizzleMediaWorkerRepo } from "../../src/services/media-worker-repo.js"

const pg = await withPg()

const FINALIZED_ETAG = "5d41402abc4b2a76b9719d911017c592"
const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000

describe.skipIf(!pg)("media_assets.upload_etag (integration)", () => {
  let h: PgHarness

  beforeAll(() => {
    h = pg as PgHarness
  })

  afterAll(async () => {
    await h.teardown()
  })

  async function insertValidating(): Promise<{ id: string; uploadId: string }> {
    const id = randomUUID()
    const uploadId = randomUUID()
    await makeDrizzleMediaRepository(h.db).insert({
      id,
      uploadId,
      kind: "image",
      r2Key: `uploads/2026/09/${uploadId}`,
      status: "validating",
      byteSize: 1024,
      uploader: "u:00000000-0000-4000-8000-0000000000e1",
    })
    return { id, uploadId }
  }

  async function uploadEtagOf(id: string): Promise<string | null> {
    const [row] = await h.sql<{ upload_etag: string | null }[]>`
      SELECT upload_etag FROM media_assets WHERE id = ${id}
    `
    return row!.upload_etag
  }

  it("the column exists as nullable text with no default", async () => {
    const [col] = await h.sql<
      { data_type: string; is_nullable: string; column_default: string | null }[]
    >`
      SELECT data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = 'media_assets' AND column_name = 'upload_etag'
    `
    expect(col).toEqual({ data_type: "text", is_nullable: "YES", column_default: null })
  })

  it("markFinalized writes the etag once, and a repeat claim neither wins nor overwrites it", async () => {
    const repo = makeDrizzleMediaRepository(h.db)
    const { id, uploadId } = await insertValidating()

    expect(await uploadEtagOf(id)).toBeNull()
    const claimed = await repo.markFinalized(uploadId, FINALIZED_ETAG)
    expect(claimed?.id).toBe(id)
    expect(await uploadEtagOf(id)).toBe(FINALIZED_ETAG)

    expect(await repo.markFinalized(uploadId, "someone-else")).toBeNull()
    expect(await uploadEtagOf(id)).toBe(FINALIZED_ETAG)
  })

  it("the stuck sweep returns the stored etag, and NULL for a row finalized before the column", async () => {
    const repo = makeDrizzleMediaRepository(h.db)
    const withEtag = await insertValidating()
    await repo.markFinalized(withEtag.uploadId, FINALIZED_ETAG)
    const legacy = await insertValidating()

    const stuckSince = new Date(Date.now() - DAY_MS)
    await h.sql`
      UPDATE media_assets SET finalized_at = ${stuckSince}
      WHERE id IN (${withEtag.id}, ${legacy.id})
    `

    const worker = makeDrizzleMediaWorkerRepo(h.db, h.sql)
    const picked = await worker.findStuckValidating(new Date(Date.now() - HOUR_MS), 100)
    const byId = new Map(picked.map((row) => [row.id, row]))

    expect(byId.get(withEtag.id)?.uploadEtag).toBe(FINALIZED_ETAG)
    expect(byId.get(legacy.id)).toBeDefined()
    expect(byId.get(legacy.id)!.uploadEtag).toBeNull()
  })
})
