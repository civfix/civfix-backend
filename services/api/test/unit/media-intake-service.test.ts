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


const SHA = "a".repeat(64)

function imageReq(over: Partial<CreateMediaUploadRequest> = {}): CreateMediaUploadRequest {
  return { kind: "image", contentType: "image/jpeg", byteSize: 32 * 1024, sha256: SHA, ...over }
}
function videoReq(over: Partial<CreateMediaUploadRequest> = {}): CreateMediaUploadRequest {
  return { kind: "video", contentType: "video/mp4", byteSize: 4 * 1024 * 1024, sha256: SHA, ...over }
}

function makeHarness(over: { logger?: { warn(obj: unknown, msg?: string): void } } = {}) {
  const repo = new InMemoryMediaRepository()
  const storage = new FakeStorage()
  const jobs = new FakeJobs()
  const service: MediaIntakeService = makeMediaIntakeService({ repo, storage, jobs, ...over })
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
    expect(() => precheckUpload(imageReq({ contentType: "image/gif" }))).toThrow()
    expect(() => precheckUpload(imageReq({ contentType: "image/heic" }))).toThrow()
    expect(() => precheckUpload(imageReq({ contentType: "image/heif" }))).toThrow()
    expect(() => precheckUpload(videoReq({ contentType: "image/jpeg" }))).toThrow()
  })

  it("rejects a sha256 that is not 64 hex chars", () => {
    expect(() => precheckUpload(imageReq({ sha256: "deadbeef" }))).toThrow()
    expect(() => precheckUpload(imageReq({ sha256: "g".repeat(64) }))).toThrow()
    expect(() => precheckUpload(imageReq({ sha256: "A".repeat(64) }))).not.toThrow()
  })
})

describe("buildR2Key", () => {
  it("keys on the server-issued uploadId under uploads/<yyyy>/<mm>/<uploadId>", () => {
    const uploadId = "11111111-2222-4333-8444-555555555555"
    const key = buildR2Key(uploadId, new Date("2026-05-31T12:00:00.000Z"))
    expect(key).toBe(`uploads/2026/05/${uploadId}`)
  })
})

describe("createUpload", () => {
  it("inserts a validating row and presigns the PUT via storage (returns putUrl + headers)", async () => {
    const { repo, service } = makeHarness()
    const res = await service.createUpload(imageReq(), { anonSessionId: "anon-1" })

    expect(repo.byId.size).toBe(1)
    const row = [...repo.byId.values()][0]!
    expect(row.status).toBe("validating")
    expect(row.uploadId).toBe(res.uploadId)
    expect(row.r2Key).toBe(`uploads/${row.r2Key.split("/")[1]}/${row.r2Key.split("/")[2]}/${res.uploadId}`)
    expect(row.r2Key.endsWith(res.uploadId)).toBe(true)
    expect(row.byteSize).toBe(32 * 1024)

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

    const asset = await row(created.uploadId)
    await storage.put(asset.r2Key, new Uint8Array(32 * 1024), { contentType: "image/jpeg" })

    const fin = await service.finalize({ uploadId: created.uploadId }, {})
    expect(fin.mediaId).toBe(asset.id)

    const finalized = await row(created.uploadId)
    expect(finalized.status).toBe("validating")

    const enqueued = jobs.jobsFor(MEDIA_CHECKS_JOB)
    expect(enqueued).toHaveLength(1)
    expect(enqueued[0]?.data).toMatchObject({
      uploadId: created.uploadId,
      r2Key: asset.r2Key,
      kind: "image",
    })
    expect(enqueued[0]?.opts?.singletonKey).toBe(created.uploadId)
  })

  it("F087: a double finalize enqueues media.checks EXACTLY ONCE (the finalized_at CAS, not pg-boss dedup)", async () => {
    const { storage, jobs, service, row } = makeHarness()
    const created = await service.createUpload(imageReq(), {})
    const asset = await row(created.uploadId)
    await storage.put(asset.r2Key, new Uint8Array(32 * 1024), { contentType: "image/jpeg" })

    const first = await service.finalize({ uploadId: created.uploadId }, {})
    const second = await service.finalize({ uploadId: created.uploadId }, {})

    expect(second).toEqual(first)
    expect((await row(created.uploadId)).status).toBe("validating")
    expect(jobs.jobsFor(MEDIA_CHECKS_JOB)).toHaveLength(1)
  })

  it("F087: the CAS survives the whole processing window - a re-finalize while the row is still validating never re-enqueues", async () => {
    const { storage, jobs, service, row } = makeHarness()
    const created = await service.createUpload(imageReq(), {})
    const asset = await row(created.uploadId)
    await storage.put(asset.r2Key, new Uint8Array(32 * 1024), { contentType: "image/jpeg" })

    await service.finalize({ uploadId: created.uploadId }, {})
    for (let i = 0; i < 5; i++) {
      await service.finalize({ uploadId: created.uploadId }, {})
    }

    expect(jobs.jobsFor(MEDIA_CHECKS_JOB)).toHaveLength(1)
    expect((await row(created.uploadId)).finalizedAt).toBeInstanceOf(Date)
  })

  it("F087: a FAILED media.checks enqueue KEEPS the finalize claim and returns success - the stuck sweep is the backstop", async () => {
    const warnings: unknown[] = []
    const { storage, jobs, service, row } = makeHarness({
      logger: { warn: (obj: unknown) => warnings.push(obj) },
    })
    const created = await service.createUpload(imageReq(), {})
    const asset = await row(created.uploadId)
    await storage.put(asset.r2Key, new Uint8Array(32 * 1024), { contentType: "image/jpeg" })

    const patched = jobs as unknown as { enqueue: (...a: unknown[]) => Promise<string> }
    patched.enqueue = () => Promise.reject(new Error("queue down"))

    // The rollback this used to do (clearFinalized) revoked a claim whose idempotent success a
    // CONCURRENT finalize could already have been handed: that caller was told "validating, job queued"
    // and would then wait forever on a row whose watermark had been nulled behind it - and a bound row
    // with finalized_at NULL is invisible to BOTH sweeps (findOrphans skips bound rows, the stuck sweep
    // requires the watermark), so nothing ever reclaimed it. The claim now stands; the row is exactly
    // the shape the stuck sweep picks up.
    const fin = await service.finalize({ uploadId: created.uploadId }, {})
    expect(fin).toEqual({ mediaId: asset.id, status: "validating" })
    expect((await row(created.uploadId)).finalizedAt).toBeInstanceOf(Date)
    expect(jobs.jobsFor(MEDIA_CHECKS_JOB)).toHaveLength(0)
    expect(warnings).toHaveLength(1)

    // ...and the CAS is not replayable, so a client retry cannot mint a second job either.
    const again = await service.finalize({ uploadId: created.uploadId }, {})
    expect(again).toEqual(fin)
    expect(jobs.jobsFor(MEDIA_CHECKS_JOB)).toHaveLength(0)
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
    await expect(
      service.finalize({ uploadId: created.uploadId }, {}),
    ).rejects.toMatchObject({ code: "MEDIA_REJECTED" })
    expect(jobs.jobsFor(MEDIA_CHECKS_JOB)).toHaveLength(0)
  })

  it("rejects when the stored object size grossly mismatches the declared byteSize", async () => {
    const { storage, service, row } = makeHarness()
    const created = await service.createUpload(imageReq(), {})
    const asset = await row(created.uploadId)
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
