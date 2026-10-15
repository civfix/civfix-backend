import { describe, expect, it } from "vitest"
import { FakeStorage } from "@civfix/shared/fakes"
import { servedKey } from "../../src/jobs/media-keys.js"
import {
  UploadReapInfraError,
  parseUploadReapPayload,
  runUploadReapJob,
  uploadReapDelaySec,
} from "../../src/jobs/upload-reap.js"
import { InMemoryMediaWorkerRepository } from "../helpers/in-memory-media-worker-repository.js"

function env() {
  const storage = new FakeStorage()
  const repo = new InMemoryMediaWorkerRepository()
  return {
    storage,
    repo,
    deps: { repo, storage, log: () => {}, report: () => {} },
  }
}

async function seedPublished(
  storage: FakeStorage,
  repo: InMemoryMediaWorkerRepository,
  over: { status?: "ready" | "held" | "rejected" | "validating"; servedKey?: string | null } = {},
) {
  const id = "m1"
  const uploadId = "u1"
  const r2Key = "uploads/2026/09/m1"
  repo.seed({
    id,
    uploadId,
    kind: "image",
    r2Key,
    status: over.status ?? "ready",
    servedKey: over.servedKey === undefined ? servedKey(r2Key) : over.servedKey,
  })
  await storage.put(servedKey(r2Key), Buffer.from([1]), { contentType: "image/jpeg" })
  return { id, uploadId, r2Key }
}

describe("media.upload.reap", () => {
  it("waits until the presigned PUT can no longer be used", () => {
    expect(uploadReapDelaySec()).toBeGreaterThan(15 * 60)
  })

  it("deletes an upload object the uploader re-PUT after publish", async () => {
    const { storage, repo, deps } = env()
    const { id, uploadId, r2Key } = await seedPublished(storage, repo)
    await storage.put(r2Key, Buffer.from([9, 9, 9]), { contentType: "image/jpeg" })
    expect(storage.get(r2Key)).not.toBeNull()

    const outcome = await runUploadReapJob({ mediaId: id, uploadId, r2Key }, deps)

    expect(outcome).toBe("deleted")
    expect(storage.get(r2Key)).toBeNull()
    expect(storage.get(servedKey(r2Key))).not.toBeNull()
  })

  it("deletes for a rejected row too (same re-PUT shape)", async () => {
    const { storage, repo, deps } = env()
    const { id, uploadId, r2Key } = await seedPublished(storage, repo, {
      status: "rejected",
      servedKey: null,
    })
    await storage.put(r2Key, Buffer.from([9]), { contentType: "image/jpeg" })

    expect(await runUploadReapJob({ mediaId: id, uploadId, r2Key }, deps)).toBe("deleted")
    expect(storage.get(r2Key)).toBeNull()
  })

  it("deletes when the row is gone entirely", async () => {
    const { storage, deps } = env()
    const r2Key = "uploads/2026/09/ghost"
    await storage.put(r2Key, Buffer.from([9]), { contentType: "image/jpeg" })

    expect(await runUploadReapJob({ mediaId: "gone", uploadId: "gone", r2Key }, deps)).toBe(
      "deleted",
    )
    expect(storage.get(r2Key)).toBeNull()
  })

  it("KEEPS the object for a legacy row whose served_key IS the upload key (pre-0097 backfill)", async () => {
    const { storage, repo, deps } = env()
    const r2Key = "uploads/2026/01/legacy"
    repo.seed({
      id: "legacy",
      uploadId: "legacy-u",
      kind: "image",
      r2Key,
      status: "ready",
      servedKey: r2Key,
    })
    await storage.put(r2Key, Buffer.from([1]), { contentType: "image/jpeg" })

    expect(await runUploadReapJob({ mediaId: "legacy", uploadId: "legacy-u", r2Key }, deps)).toBe(
      "kept",
    )
    expect(storage.get(r2Key)).not.toBeNull()
  })

  it("KEEPS the object while the asset is still validating (a re-drive is in flight)", async () => {
    const { storage, repo, deps } = env()
    const { id, uploadId, r2Key } = await seedPublished(storage, repo, {
      status: "validating",
      servedKey: null,
    })
    await storage.put(r2Key, Buffer.from([1]), { contentType: "image/jpeg" })

    expect(await runUploadReapJob({ mediaId: id, uploadId, r2Key }, deps)).toBe("kept")
    expect(storage.get(r2Key)).not.toBeNull()
  })

  it("KEEPS the object when another row still references the key", async () => {
    const { storage, repo, deps } = env()
    const { id, uploadId, r2Key } = await seedPublished(storage, repo)
    repo.seed({ id: "other", uploadId: "other-u", kind: "image", r2Key, status: "ready" })
    await storage.put(r2Key, Buffer.from([1]), { contentType: "image/jpeg" })

    expect(await runUploadReapJob({ mediaId: id, uploadId, r2Key }, deps)).toBe("kept")
    expect(storage.get(r2Key)).not.toBeNull()
  })

  it("tombstones instead of throwing when the delete fails", async () => {
    const { storage, repo, deps } = env()
    const { id, uploadId, r2Key } = await seedPublished(storage, repo)
    await storage.put(r2Key, Buffer.from([1]), { contentType: "image/jpeg" })
    ;(storage as unknown as { delete: () => Promise<void> }).delete = () =>
      Promise.reject(new Error("R2 down"))

    expect(await runUploadReapJob({ mediaId: id, uploadId, r2Key }, deps)).toBe("leaked")
    expect(repo.tombstones.get(r2Key)).toBeDefined()
  })

  it("THROWS on a DB fault so pg-boss retries (the queue has a retry budget)", async () => {
    const { storage, repo, deps } = env()
    const { id, uploadId, r2Key } = await seedPublished(storage, repo)
    await storage.put(r2Key, Buffer.from([1]), { contentType: "image/jpeg" })
    repo.findById = () => Promise.reject(new Error("db down"))
    repo.findByUploadId = () => Promise.reject(new Error("db down"))

    await expect(runUploadReapJob({ mediaId: id, uploadId, r2Key }, deps)).rejects.toBeInstanceOf(
      UploadReapInfraError,
    )
    expect(storage.get(r2Key)).not.toBeNull()
  })

  it("THROWS when the shared-key reference check cannot be made", async () => {
    const { storage, repo, deps } = env()
    const { id, uploadId, r2Key } = await seedPublished(storage, repo)
    await storage.put(r2Key, Buffer.from([1]), { contentType: "image/jpeg" })
    repo.r2KeyReferencedByOthers = () => Promise.reject(new Error("db down"))

    await expect(runUploadReapJob({ mediaId: id, uploadId, r2Key }, deps)).rejects.toBeInstanceOf(
      UploadReapInfraError,
    )
    expect(storage.get(r2Key)).not.toBeNull()
  })

  it("rejects a malformed payload rather than guessing", () => {
    expect(parseUploadReapPayload(null)).toBeNull()
    expect(parseUploadReapPayload({ mediaId: "a", uploadId: "b" })).toBeNull()
    expect(parseUploadReapPayload({ mediaId: "a", uploadId: "b", r2Key: "c" })).toEqual({
      mediaId: "a",
      uploadId: "b",
      r2Key: "c",
    })
  })
})
