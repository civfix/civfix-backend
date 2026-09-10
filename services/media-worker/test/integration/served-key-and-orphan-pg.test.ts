
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
    repo = makeDrizzleMediaWorkerRepo(h.db, h.sql)
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

  async function insertReport(): Promise<string> {
    const [row] = await h.sql<{ id: string }[]>`
      INSERT INTO reports (idempotency_key, geom, geom_source, category, type, status, visibility, h3_cell)
      VALUES (
        ${randomUUID()},
        ST_SetSRID(ST_MakePoint(-118.24, 34.05), 4326),
        'manual',
        'trash',
        'dump',
        'published',
        'public',
        'h0'
      )
      RETURNING id
    `
    if (!row) throw new Error("failed to insert report fixture")
    return row.id
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

    const reportId = await insertReport()
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
        const reportId = await insertReport()
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

  async function insertUser(name: string): Promise<string> {
    const handle = `user${randomUUID().replace(/-/g, "").slice(0, 12)}`
    const [row] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name, handle) VALUES (${name}, ${handle}) RETURNING id
    `
    if (!row) throw new Error("failed to insert user fixture")
    return row.id
  }

  async function insertCleanup(organizerId: string): Promise<string> {
    const id = randomUUID()
    await h.sql`
      INSERT INTO cleanups (id, organizer_user_id, type, title, geom, scheduled_at, status)
      VALUES (
        ${id}, ${organizerId}, 'site', 'Orphan sweep sweep',
        ST_SetSRID(ST_MakePoint(-118.25, 34.05), 4326), now() + interval '7 days', 'upcoming'
      )
    `
    return id
  }

  it("never reaps an event cover, a gallery image, an org logo or a page-block image", async () => {
    const cutoff = new Date(Date.now() - limits.orphanTtlMs)
    const organizer = await insertUser("Organizer")
    const cleanupId = await insertCleanup(organizer)

    const cover = await insertAsset({ ageMs: limits.orphanTtlMs + 60_000, status: "ready" })
    const gallery = await insertAsset({ ageMs: limits.orphanTtlMs + 60_000, status: "ready" })
    const logo = await insertAsset({ ageMs: limits.orphanTtlMs + 60_000, status: "ready" })
    const block = await insertAsset({ ageMs: limits.orphanTtlMs + 60_000, status: "ready" })
    const loose = await insertAsset({ ageMs: limits.orphanTtlMs + 60_000, status: "ready" })

    await h.sql`
      UPDATE cleanups
         SET cover_media_id = ${cover.id}, gallery_media_ids = ARRAY[${gallery.id}]::uuid[]
       WHERE id = ${cleanupId}
    `
    const [org] = await h.sql<{ id: string }[]>`
      INSERT INTO organizations (name, slug, created_by, logo_media_id)
      VALUES ('Sweepers', ${`sweepers-${randomUUID().slice(0, 8)}`}, ${organizer}, ${logo.id})
      RETURNING id
    `
    expect(org).toBeDefined()
    await h.sql`
      INSERT INTO cleanup_page_media (cleanup_id, media_id) VALUES (${cleanupId}, ${block.id})
    `

    const found = (await repo.findOrphans(cutoff, 500)).map((o) => o.id)
    expect(found).not.toContain(cover.id)
    expect(found).not.toContain(gallery.id)
    expect(found).not.toContain(logo.id)
    expect(found).not.toContain(block.id)
    expect(found).toContain(loose.id)

    for (const bound of [cover, gallery, logo, block]) {
      expect(await repo.deleteOrphan(bound.id, cutoff)).toBeNull()
    }
    const survivors = await h.sql<{ id: string }[]>`
      SELECT id FROM media_assets
       WHERE id = ANY(${[cover.id, gallery.id, logo.id, block.id]}::uuid[])
    `
    expect(survivors).toHaveLength(4)
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
