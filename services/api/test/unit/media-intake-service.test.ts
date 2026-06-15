import { describe, it, expect } from "vitest"
import { FakeStorage, FakeJobs } from "@civfix/shared/fakes"
import { MAX_IMAGE_BYTES, MAX_VIDEO_BYTES } from "@civfix/shared"
import type { CreateMediaUploadRequest } from "@civfix/shared"
import {
  makeMediaIntakeService,
  precheckUpload,
  buildR2Key,
  MEDIA_CHECKS_JOB,
  type MediaIntakeService,
} from "../../src/services/media-intake-service.js"
import { InMemoryMediaRepository } from "../helpers/media.js"

/**
 * Unit tests for the media-intake service. The pure `precheckUpload` is tested directly; the
 * create/finalize/getMedia flows run against an in-memory repository + FakeStorage + FakeJobs, so they
 * need NO database and NO Docker (mirrors the jurisdiction-service offline pattern). The Drizzle repo
 * and the real R2 adapter are covered by the Docker-gated integration suite and DI tests respectively.
 */

const SHA = "a".repeat(64)

/** A valid image upload request (32 KB JPEG). */
function imageReq(over: Partial<CreateMediaUploadRequest> = {}): CreateMediaUploadRequest {
  return { kind: "image", contentType: "image/jpeg", byteSize: 32 * 1024, sha256: SHA, ...over }
}
/** A valid video upload request (4 MB mp4). */
function videoReq(over: Partial<CreateMediaUploadRequest> = {}): CreateMediaUploadRequest {
  return { kind: "video", contentType: "video/mp4", byteSize: 4 * 1024 * 1024, sha256: SHA, ...over }
}

/** Build a service over fresh fakes; returns the service plus the fakes for assertions. */
function makeHarness() {
  const repo = new InMemoryMediaRepository()
  const storage = new FakeStorage()
  const jobs = new FakeJobs()
  const service: MediaIntakeService = makeMediaIntakeService({ repo, storage, jobs })
  /** Resolve the inserted row (id + r2Key) for an uploadId; throws if absent so setup fails loudly. */
  async function row(uploadId: string) {
    const found = await repo.findByUploadId(uploadId)
    if (!found) throw new Error(`no media row for uploadId ${uploadId}`)
    return found
  }
  return { repo, storage, jobs, service, row }
}

describe("precheckUpload (pure)", () => {
  it("accepts a valid image and a valid video", () => {
    expect(() => precheckUpload(imageReq())).not.toThrow()
    expect(() => precheckUpload(videoReq())).not.toThrow()
  })

  it("rejects an oversize image (> MAX_IMAGE_BYTES)", () => {
    try {
      precheckUpload(imageReq({ byteSize: MAX_IMAGE_BYTES + 1 }))
      throw new Error("expected rejection")
    } catch (err) {
      expect((err as { code?: string }).code).toBe("MEDIA_REJECTED")
    }
  })

  it("rejects an oversize video (> MAX_VIDEO_BYTES)", () => {
    try {
      precheckUpload(videoReq({ byteSize: MAX_VIDEO_BYTES + 1 }))
      throw new Error("expected rejection")
    } catch (err) {
      expect((err as { code?: string }).code).toBe("MEDIA_REJECTED")
    }
  })

  it("rejects a disallowed contentType for the kind", () => {
    // gif is not on the image allowlist...
    expect(() => precheckUpload(imageReq({ contentType: "image/gif" }))).toThrow()
    // ...HEIC/HEIF are rejected too: the media-worker's prebuilt sharp/libvips cannot decode HEVC-coded
    // HEIF, so accepting it would yield a report whose served image is an unrenderable HEIC (blank on web).
    expect(() => precheckUpload(imageReq({ contentType: "image/heic" }))).toThrow()
    expect(() => precheckUpload(imageReq({ contentType: "image/heif" }))).toThrow()
    // ...and an image contentType is not valid for a video upload.
    expect(() => precheckUpload(videoReq({ contentType: "image/jpeg" }))).toThrow()
  })

  it("rejects a sha256 that is not 64 hex chars", () => {
    expect(() => precheckUpload(imageReq({ sha256: "deadbeef" }))).toThrow()
    expect(() => precheckUpload(imageReq({ sha256: "g".repeat(64) }))).toThrow()
    expect(() => precheckUpload(imageReq({ sha256: "A".repeat(64) }))).not.toThrow() // upper-cased hex ok
  })
})

describe("buildR2Key", () => {
  it("is content-addressed under uploads/<yyyy>/<mm>/<sha>", () => {
    const key = buildR2Key(SHA, new Date("2026-05-31T12:00:00.000Z"))
    expect(key).toBe(`uploads/2026/05/${SHA}`)
  })
})

describe("createUpload", () => {
  it("inserts a validating row and presigns the PUT via storage (returns putUrl + headers)", async () => {
    const { repo, service } = makeHarness()
    const res = await service.createUpload(imageReq(), { anonSessionId: "anon-1" })

    // A row was inserted at status "validating" with the content-addressed key and report_id null.
    expect(repo.byId.size).toBe(1)
    const row = [...repo.byId.values()][0]!
    expect(row.status).toBe("validating")
    expect(row.uploadId).toBe(res.uploadId)
    expect(row.r2Key).toMatch(/^uploads\/\d{4}\/\d{2}\/a{64}$/)
    expect(row.byteSize).toBe(32 * 1024)

    // The presign went to FakeStorage for THAT key (memory://<key>) and the headers came back.
    expect(res.putUrl).toBe(`memory://${row.r2Key}`)
    expect(res.headers["content-type"]).toBe("image/jpeg")
    expect(res.headers["content-length"]).toBe(String(32 * 1024))
  })

  it("rejects an oversize video before inserting or presigning", async () => {
    const { repo, jobs, service } = makeHarness()
    await expect(
      service.createUpload(videoReq({ byteSize: MAX_VIDEO_BYTES + 1 }), {}),
    ).rejects.toMatchObject({ code: "MEDIA_REJECTED" })
    expect(repo.byId.size).toBe(0)
    expect(jobs.enqueued).toHaveLength(0)
  })
})

describe("finalize", () => {
  it("marks the media VALIDATING and enqueues the media.checks job (EXIF/GPS strip + NSFW/dedupe)", async () => {
    const { storage, jobs, service, row } = makeHarness()
    const created = await service.createUpload(imageReq(), {})

    // Simulate the client having PUT the bytes: the object now exists at the key with the right size.
    const asset = await row(created.uploadId)
    await storage.put(asset.r2Key, new Uint8Array(32 * 1024), { contentType: "image/jpeg" })

    const fin = await service.finalize({ uploadId: created.uploadId }, {})
    expect(fin.mediaId).toBe(asset.id)

    // The row stays VALIDATING (NOT yet public): serving the raw upload would leak the camera's EXIF/GPS.
    // The worker promotes it to "ready" only after stripping metadata + running the abuse seams.
    const finalized = await row(created.uploadId)
    expect(finalized.status).toBe("validating")

    // Exactly one media.checks job is enqueued, carrying the handles the worker needs, deduped by uploadId.
    const enqueued = jobs.jobsFor(MEDIA_CHECKS_JOB)
    expect(enqueued).toHaveLength(1)
    expect(enqueued[0]?.data).toMatchObject({
      uploadId: created.uploadId,
      r2Key: asset.r2Key,
      kind: "image",
    })
    expect(enqueued[0]?.opts?.singletonKey).toBe(created.uploadId)
  })

  it("is idempotent: a double finalize keeps the media validating and dedupes the checks job by uploadId", async () => {
    const { storage, jobs, service, row } = makeHarness()
    const created = await service.createUpload(imageReq(), {})
    const asset = await row(created.uploadId)
    await storage.put(asset.r2Key, new Uint8Array(32 * 1024), { contentType: "image/jpeg" })

    await service.finalize({ uploadId: created.uploadId }, {})
    await service.finalize({ uploadId: created.uploadId }, {})

    expect((await row(created.uploadId)).status).toBe("validating")
    // singletonKey=uploadId dedupes in production (pg-boss); assert the checks job was enqueued.
    expect(jobs.jobsFor(MEDIA_CHECKS_JOB).length).toBeGreaterThanOrEqual(1)
  })

  it("rejects finalize for an unknown uploadId (404) without enqueueing", async () => {
    const { jobs, service } = makeHarness()
    await expect(
      service.finalize({ uploadId: "00000000-0000-0000-0000-000000000000" }, {}),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
    expect(jobs.enqueued).toHaveLength(0)
  })

  it("rejects when the uploaded object is missing in storage", async () => {
    const { jobs, service } = makeHarness()
    const created = await service.createUpload(imageReq(), {})
    // No storage.put -> head() returns null.
    await expect(
      service.finalize({ uploadId: created.uploadId }, {}),
    ).rejects.toMatchObject({ code: "MEDIA_REJECTED" })
    expect(jobs.jobsFor(MEDIA_CHECKS_JOB)).toHaveLength(0)
  })

  it("rejects when the stored object size grossly mismatches the declared byteSize", async () => {
    const { storage, service, row } = makeHarness()
    const created = await service.createUpload(imageReq(), {})
    const asset = await row(created.uploadId)
    // Declared 32 KB, but the object is 1 byte -> gross mismatch.
    await storage.put(asset.r2Key, new Uint8Array(1), { contentType: "image/jpeg" })
    await expect(
      service.finalize({ uploadId: created.uploadId }, {}),
    ).rejects.toMatchObject({ code: "MEDIA_REJECTED" })
  })
})

describe("getMedia", () => {
  it("returns a MediaDTO with a presignGet URL for ready media (incl. thumbUrl when set)", async () => {
    const { repo, service, row } = makeHarness()
    const created = await service.createUpload(imageReq(), {})
    const asset = await row(created.uploadId)
    // Mark it ready with dimensions + a thumb_key, as the worker eventually would.
    repo.patch(asset.id, {
      status: "ready",
      width: 1200,
      height: 800,
      thumbKey: `${asset.r2Key}.thumb`,
    })

    const dto = await service.getMedia(asset.id, {})
    expect(dto.id).toBe(asset.id)
    expect(dto.kind).toBe("image")
    expect(dto.status).toBe("ready")
    expect(dto.url).toBe(`memory://${asset.r2Key}`)
    expect(dto.thumbUrl).toBe(`memory://${asset.r2Key}.thumb`)
    expect(dto.width).toBe(1200)
    expect(dto.height).toBe(800)
  })

  it("404s for not-yet-ready media (validating) via the public path", async () => {
    const { service, row } = makeHarness()
    const created = await service.createUpload(imageReq(), {})
    const asset = await row(created.uploadId)
    await expect(service.getMedia(asset.id, {})).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  it("404s for an unknown id", async () => {
    const { service } = makeHarness()
    await expect(
      service.getMedia("00000000-0000-0000-0000-000000000000", {}),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
  })
})
