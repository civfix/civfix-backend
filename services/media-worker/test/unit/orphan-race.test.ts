import { describe, expect, it } from "vitest"
import { FakeStorage } from "@civfix/shared/fakes"
import { loadLimits, type WorkerLimits } from "../../src/config.js"
import { runOrphanSweep } from "../../src/jobs/orphan-sweep.js"
import { servedKey, thumbnailKey } from "../../src/jobs/media-keys.js"
import { InMemoryMediaWorkerRepository } from "../helpers/in-memory-media-worker-repository.js"

const limits: WorkerLimits = loadLimits({})
const NOW = new Date("2026-09-02T12:00:00Z")

async function seedOrphan(storage: FakeStorage, repo: InMemoryMediaWorkerRepository, id: string) {
  const r2Key = `uploads/2026/09/${id}`
  repo.seed({
    id,
    uploadId: `up-${id}`,
    kind: "image",
    r2Key,
    servedKey: servedKey(r2Key),
    thumbKey: thumbnailKey(r2Key),
    status: "ready",
    createdAt: new Date(NOW.getTime() - limits.orphanTtlMs - 60_000),
  })
  for (const key of [r2Key, servedKey(r2Key), thumbnailKey(r2Key)]) {
    await storage.put(key, Buffer.from([1]), { contentType: "image/jpeg" })
  }
  return r2Key
}

function sweep(repo: InMemoryMediaWorkerRepository, storage: FakeStorage) {
  return runOrphanSweep({ repo, storage, limits, now: () => NOW, log: () => {}, report: () => {} })
}

describe("orphan sweep legacy served-key adoption", () => {
  it("stamps served_key = r2_key on pre-0097 ready rows once their PUT window has passed", async () => {
    const storage = new FakeStorage()
    const repo = new InMemoryMediaWorkerRepository()
    const r2Key = "uploads/2026/01/legacy"
    repo.seed({
      id: "legacy",
      uploadId: "legacy-u",
      kind: "image",
      r2Key,
      reportId: "report-1",
      status: "ready",
      servedKey: null,
      createdAt: new Date(NOW.getTime() - 24 * 60 * 60 * 1000),
    })

    const result = await sweep(repo, storage)

    expect(result.adoptedLegacyServedKeys).toBe(1)
    expect(repo.get("legacy")!.servedKey).toBe(r2Key)
    expect(repo.get("legacy")!.status).toBe("ready")
  })

  it("leaves a row alone while its presigned PUT could still be replayed", async () => {
    const storage = new FakeStorage()
    const repo = new InMemoryMediaWorkerRepository()
    repo.seed({
      id: "fresh",
      uploadId: "fresh-u",
      kind: "image",
      r2Key: "uploads/2026/09/fresh",
      reportId: "report-1",
      status: "ready",
      servedKey: null,
      createdAt: new Date(NOW.getTime() - 60_000),
    })

    const result = await sweep(repo, storage)

    expect(result.adoptedLegacyServedKeys).toBe(0)
    expect(repo.get("fresh")!.servedKey).toBeNull()
  })
})

describe("orphan sweep race with a bind", () => {
  it("skips the reap and the object deletes when the row was bound after the SELECT", async () => {
    const storage = new FakeStorage()
    const repo = new InMemoryMediaWorkerRepository()
    const r2Key = await seedOrphan(storage, repo, "raced")

    const realFind = repo.findOrphans.bind(repo)
    repo.findOrphans = async (olderThan, limit) => {
      const rows = await realFind(olderThan, limit)
      const row = repo.byId.get("raced")
      if (row) row.reportId = "report-1"
      return rows
    }

    const result = await sweep(repo, storage)

    expect(result.scanned).toBe(1)
    expect(result.deleted).toBe(0)
    expect(result.boundMeanwhile).toBe(1)
    expect(result.errors).toBe(0)
    expect(repo.byId.get("raced")).toBeDefined()
    expect(storage.get(r2Key)).not.toBeNull()
    expect(storage.get(servedKey(r2Key))).not.toBeNull()
    expect(storage.get(thumbnailKey(r2Key))).not.toBeNull()
  })

  it("still reaps a genuine orphan, including its served and thumbnail objects", async () => {
    const storage = new FakeStorage()
    const repo = new InMemoryMediaWorkerRepository()
    const r2Key = await seedOrphan(storage, repo, "genuine")

    const result = await sweep(repo, storage)

    expect(result.deleted).toBe(1)
    expect(result.boundMeanwhile).toBe(0)
    expect(repo.byId.get("genuine")).toBeUndefined()
    expect(storage.get(r2Key)).toBeNull()
    expect(storage.get(servedKey(r2Key))).toBeNull()
    expect(storage.get(thumbnailKey(r2Key))).toBeNull()
  })

  it("skips a row an avatar claimed after the SELECT", async () => {
    const storage = new FakeStorage()
    const repo = new InMemoryMediaWorkerRepository()
    const r2Key = await seedOrphan(storage, repo, "avatar")

    const realFind = repo.findOrphans.bind(repo)
    repo.findOrphans = async (olderThan, limit) => {
      const rows = await realFind(olderThan, limit)
      repo.seedAvatarReference("avatar")
      return rows
    }

    const result = await sweep(repo, storage)

    expect(result.boundMeanwhile).toBe(1)
    expect(repo.byId.get("avatar")).toBeDefined()
    expect(storage.get(r2Key)).not.toBeNull()
  })
})
