import { describe, expect, it } from "vitest"
import { FakeStorage, FakeAbuseChecks } from "@civfix/shared/fakes"
import type { StorageHead } from "@civfix/shared/interfaces"
import { loadLimits, type WorkerLimits } from "../../src/config.js"
import { makeDownloader } from "../../src/download.js"
import { runMediaChecksJob, type MediaChecksDeps } from "../../src/jobs/media-checks.js"
import { servedKey, thumbnailKey } from "../../src/jobs/media-keys.js"
import { InMemoryMediaWorkerRepository } from "../helpers/in-memory-media-worker-repository.js"
import * as fx from "../fixtures/make.js"

const limits: WorkerLimits = loadLimits({})

function makeDeps(over?: Partial<MediaChecksDeps>): {
  deps: MediaChecksDeps
  storage: FakeStorage
  repo: InMemoryMediaWorkerRepository
} {
  const storage = new FakeStorage()
  const repo = new InMemoryMediaWorkerRepository()
  const deps: MediaChecksDeps = {
    repo,
    storage,
    abuseChecks: new FakeAbuseChecks(),
    limits,
    download: makeDownloader(storage),
    report: () => {},
    log: () => {},
    ...over,
  }
  return { deps, storage, repo }
}

async function seed(
  storage: FakeStorage,
  repo: InMemoryMediaWorkerRepository,
  bytes: Uint8Array,
): Promise<{ id: string; uploadId: string; r2Key: string }> {
  const id = `media-${Math.random().toString(36).slice(2, 10)}`
  const uploadId = `up-${Math.random().toString(36).slice(2, 10)}`
  const r2Key = `uploads/2026/09/${id}`
  repo.seed({ id, uploadId, kind: "image", r2Key })
  await storage.put(r2Key, Buffer.from(bytes), { contentType: "image/jpeg" })
  return { id, uploadId, r2Key }
}

describe("C1: processed media is published to a worker-owned key", () => {
  it("writes the processed object to served_key, records it, and deletes the upload object", async () => {
    const { deps, storage, repo } = makeDeps()
    const { id, uploadId, r2Key } = await seed(storage, repo, await fx.makeValidJpegWithGps())

    const status = await runMediaChecksJob({ mediaId: id, uploadId, r2Key, kind: "image" }, deps)

    expect(status).toBe("ready")
    const row = repo.get(id)!
    expect(row.servedKey).toBe(servedKey(r2Key))
    expect(row.servedKey).not.toBe(r2Key)
    expect(storage.get(servedKey(r2Key))).not.toBeNull()
    expect(storage.get(thumbnailKey(r2Key))).not.toBeNull()
    expect(storage.get(r2Key)).toBeNull()
  })

  it("rejects (never throws) when the upload object was overwritten during processing", async () => {
    const { deps, storage, repo } = makeDeps()
    const { id, uploadId, r2Key } = await seed(storage, repo, await fx.makeValidPng())
    let etag = "aaa"
    const head = (key: string): Promise<StorageHead | null> =>
      key === r2Key
        ? Promise.resolve({ size: 1, contentType: "image/png", etag } as StorageHead)
        : Promise.resolve(null)
    ;(storage as unknown as { head: typeof head }).head = head
    const inner = makeDownloader(storage)
    const download: MediaChecksDeps["download"] = async (key, max, signal) => {
      const out = await inner(key, max, signal)
      etag = "bbb"
      return { bytes: out.bytes, etag: "aaa" }
    }

    const status = await runMediaChecksJob(
      { mediaId: id, uploadId, r2Key, kind: "image" },
      { ...deps, download },
    )

    expect(status).toBe("rejected")
    expect(repo.get(id)!.status).toBe("rejected")
    expect(repo.get(id)!.servedKey).toBeNull()
    expect(storage.get(servedKey(r2Key))).toBeNull()
  })

  it("rejects when the finalize-time ETag does not match the bytes it downloaded", async () => {
    const { deps, storage, repo } = makeDeps()
    const { id, uploadId, r2Key } = await seed(storage, repo, await fx.makeValidPng())
    const inner = makeDownloader(storage)
    const download: MediaChecksDeps["download"] = async (key, max, signal) => ({
      bytes: (await inner(key, max, signal)).bytes,
      etag: "downloaded-version",
    })

    const status = await runMediaChecksJob(
      { mediaId: id, uploadId, r2Key, kind: "image", uploadEtag: "finalized-version" },
      { ...deps, download },
    )

    expect(status).toBe("rejected")
    expect(repo.get(id)!.servedKey).toBeNull()
    expect(storage.get(servedKey(r2Key))).toBeNull()
  })

  it("publishes when the ETags agree end to end", async () => {
    const { deps, storage, repo } = makeDeps()
    const { id, uploadId, r2Key } = await seed(storage, repo, await fx.makeValidPng())
    const inner = makeDownloader(storage)
    const download: MediaChecksDeps["download"] = async (key, max, signal) => ({
      bytes: (await inner(key, max, signal)).bytes,
      etag: "same",
    })
    ;(storage as unknown as { head: (k: string) => Promise<StorageHead | null> }).head = (k) =>
      Promise.resolve(
        k === r2Key ? ({ size: 1, contentType: "image/png", etag: "same" } as StorageHead) : null,
      )

    const status = await runMediaChecksJob(
      { mediaId: id, uploadId, r2Key, kind: "image", uploadEtag: "same" },
      { ...deps, download },
    )

    expect(status).toBe("ready")
    expect(repo.get(id)!.servedKey).toBe(servedKey(r2Key))
  })

  it("refreshes bound avatar urls with the durable public url when a public base is configured", async () => {
    const { deps, storage, repo } = makeDeps({ publicMediaBase: "https://media.example.test/" })
    const { id, uploadId, r2Key } = await seed(storage, repo, await fx.makeValidJpegWithGps())
    const calls: { mediaId: string; avatarUrl: string }[] = []
    repo.refreshAvatarUrls = (mediaId: string, avatarUrl: string) => {
      calls.push({ mediaId, avatarUrl })
      return Promise.resolve(1)
    }

    const status = await runMediaChecksJob({ mediaId: id, uploadId, r2Key, kind: "image" }, deps)

    expect(status).toBe("ready")
    expect(calls).toEqual([
      { mediaId: id, avatarUrl: `https://media.example.test/${servedKey(r2Key)}` },
    ])
  })

  it("does not refresh avatar urls without a public base (signed-url deployments derive at read time)", async () => {
    const { deps, storage, repo } = makeDeps()
    const { id, uploadId, r2Key } = await seed(storage, repo, await fx.makeValidJpegWithGps())
    const calls: string[] = []
    repo.refreshAvatarUrls = (mediaId: string) => {
      calls.push(mediaId)
      return Promise.resolve(1)
    }

    const status = await runMediaChecksJob({ mediaId: id, uploadId, r2Key, kind: "image" }, deps)

    expect(status).toBe("ready")
    expect(calls).toEqual([])
  })

  it("a failed avatar url refresh is non-fatal and the job still completes", async () => {
    const { deps, storage, repo } = makeDeps({ publicMediaBase: "https://media.example.test" })
    const { id, uploadId, r2Key } = await seed(storage, repo, await fx.makeValidJpegWithGps())
    repo.refreshAvatarUrls = () => Promise.reject(new Error("users table unavailable"))

    const status = await runMediaChecksJob({ mediaId: id, uploadId, r2Key, kind: "image" }, deps)

    expect(status).toBe("ready")
    expect(repo.get(id)!.servedKey).toBe(servedKey(r2Key))
  })

  it("rejects when the upload object vanished before the publish", async () => {
    const { deps, storage, repo } = makeDeps()
    const { id, uploadId, r2Key } = await seed(storage, repo, await fx.makeValidPng())
    const inner = makeDownloader(storage)
    const download: MediaChecksDeps["download"] = async (key, max, signal) => {
      const out = await inner(key, max, signal)
      await storage.delete(r2Key)
      return out
    }

    const status = await runMediaChecksJob(
      { mediaId: id, uploadId, r2Key, kind: "image" },
      { ...deps, download },
    )

    expect(status).toBe("rejected")
    expect(storage.get(servedKey(r2Key))).toBeNull()
  })
})
