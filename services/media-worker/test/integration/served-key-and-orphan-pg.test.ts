
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { FakeStorage } from "@civfix/shared/fakes"
import { makeDrizzleMediaWorkerRepo, type MediaWorkerRepo } from "@civfix/api/media-repo"
import { loadLimits } from "../../src/config.js"
import { runOrphanSweep } from "../../src/jobs/orphan-sweep.js"
import { servedKey, thumbnailKey } from "../../src/jobs/media-keys.js"
import { withWorkerPg, type WorkerPgHarness } from "../helpers/pg.js"

const pg = await withWorkerPg()
const limits = loadLimits({})

describe.skipIf(!pg)("served_key + conditional orphan reap (integration)", () => {
  let h: WorkerPgHarness
  let repo: MediaWorkerRepo
  let storage: FakeStorage

  beforeAll(() => {
    h = pg as WorkerPgHarness
    repo = makeDrizzleMediaWorkerRepo(h.db)
    storage = new FakeStorage()
  })

  afterAll(async () => {
    await h.teardown()
  })

  async function insertAsset(opts: { ageMs?: number; status?: string } = {}): Promise<{
    id: string
    r2Key: string
  }> {
    const id = randomUUID()
    const r2Key = `uploads/2026/09/${id}`
    const ageMs = opts.ageMs ?? 0
    await h.sql`
      INSERT INTO media_assets (id, upload_id, kind, r2_key, status, byte_size, created_at)
      VALUES (${id}, ${randomUUID()}, 'image', ${r2Key}, ${opts.status ?? "validating"}, 10,
              now() - make_interval(secs => ${Math.round(ageMs / 1000)}))
    `
    return { id, r2Key }
  }

  it("applyResult persists served_key alongside the terminal status", async () => {
    const { id, r2Key } = await insertAsset()

    const applied = await repo.applyResult(id, {
      status: "ready",
      servedKey: servedKey(r2Key),
      thumbKey: thumbnailKey(r2Key),
    })

    expect(applied?.servedKey).toBe(servedKey(r2Key))
    const rows = await h.sql<{ served_key: string | null }[]>`
      SELECT served_key FROM media_assets WHERE id = ${id}
    `
    expect(rows[0]?.served_key).toBe(servedKey(r2Key))
  })

  it("deleteOrphan matches nothing once the row is bound to a report", async () => {
    const { id } = await insertAsset({ ageMs: limits.orphanTtlMs + 60_000, status: "ready" })
    const cutoff = new Date(Date.now() - limits.orphanTtlMs)

    const found = await repo.findOrphans(cutoff, 100)
    expect(found.map((o) => o.id)).toContain(id)

    const reportId = randomUUID()
    await h.sql`
      INSERT INTO reports (id, category, type, status, visibility, geom)
      VALUES (${reportId}, 'trash', 'illegal_dumping', 'new', 'public',
              ST_SetSRID(ST_MakePoint(-118.24, 34.05), 4326))
    `
    await h.sql`UPDATE media_assets SET report_id = ${reportId} WHERE id = ${id}`

    expect(await repo.deleteOrphan(id, cutoff)).toBeNull()
    const rows = await h.sql<{ id: string }[]>`SELECT id FROM media_assets WHERE id = ${id}`
    expect(rows).toHaveLength(1)
  })

  it("the sweep leaves the bound row and its objects alone, counting it as boundMeanwhile", async () => {
    const { id, r2Key } = await insertAsset({ ageMs: limits.orphanTtlMs + 60_000, status: "ready" })
    for (const key of [r2Key, servedKey(r2Key), thumbnailKey(r2Key)]) {
      await storage.put(key, Buffer.from([1]), { contentType: "image/jpeg" })
    }
    await h.sql`UPDATE media_assets SET served_key = ${servedKey(r2Key)} WHERE id = ${id}`

    const racingRepo: MediaWorkerRepo = {
      ...repo,
      async findOrphans(olderThan, limit) {
        const rows = await repo.findOrphans(olderThan, limit)
        const reportId = randomUUID()
        await h.sql`
          INSERT INTO reports (id, category, type, status, visibility, geom)
          VALUES (${reportId}, 'trash', 'illegal_dumping', 'new', 'public',
                  ST_SetSRID(ST_MakePoint(-118.24, 34.05), 4326))
        `
        await h.sql`UPDATE media_assets SET report_id = ${reportId} WHERE id = ${id}`
        return rows.filter((r) => r.id === id)
      },
    }

    const result = await runOrphanSweep({
      repo: racingRepo,
      storage,
      limits,
      log: () => {},
      report: () => {},
    })

    expect(result.boundMeanwhile).toBeGreaterThanOrEqual(1)
    expect(result.deleted).toBe(0)
    const rows = await h.sql<{ id: string }[]>`SELECT id FROM media_assets WHERE id = ${id}`
    expect(rows).toHaveLength(1)
    expect(storage.get(r2Key)).not.toBeNull()
    expect(storage.get(servedKey(r2Key))).not.toBeNull()
  })

  it("still reaps a row that stayed unbound, deleting upload + served + thumb objects", async () => {
    const { id, r2Key } = await insertAsset({ ageMs: limits.orphanTtlMs + 60_000, status: "ready" })
    for (const key of [r2Key, servedKey(r2Key), thumbnailKey(r2Key)]) {
      await storage.put(key, Buffer.from([1]), { contentType: "image/jpeg" })
    }
    await h.sql`UPDATE media_assets SET served_key = ${servedKey(r2Key)} WHERE id = ${id}`

    const result = await runOrphanSweep({
      repo,
      storage,
      limits,
      log: () => {},
      report: () => {},
    })

    expect(result.deleted).toBeGreaterThanOrEqual(1)
    const rows = await h.sql<{ id: string }[]>`SELECT id FROM media_assets WHERE id = ${id}`
    expect(rows).toHaveLength(0)
    expect(storage.get(r2Key)).toBeNull()
    expect(storage.get(servedKey(r2Key))).toBeNull()
    expect(storage.get(thumbnailKey(r2Key))).toBeNull()
  })
})
