
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { FakeStorage, FakeAbuseChecks } from "@civfix/shared/fakes"
import { RealAbuseChecks } from "@civfix/api/adapters/abuse-checks"
import exifr from "exifr"
import { loadLimits, type WorkerLimits } from "../../src/config.js"
import { makeDownloader, DownloadTooLargeError, StorageUnavailableError } from "../../src/download.js"
import { perceptualHash } from "../../src/sandbox/phash.js"
import {
  processMedia,
  runMediaChecksJob,
  parsePayload,
  MediaInfraError,
  type MediaChecksDeps,
  type DownloadFn,
} from "../../src/jobs/media-checks.js"
import { InMemoryWorkerRepo } from "../helpers/in-memory-repo.js"
import * as fx from "../fixtures/make.js"

const limits: WorkerLimits = loadLimits({})

function makeDeps(over?: Partial<MediaChecksDeps>): {
  deps: MediaChecksDeps
  storage: FakeStorage
  repo: InMemoryWorkerRepo
  abuse: FakeAbuseChecks
  reports: unknown[]
} {
  const storage = new FakeStorage()
  const repo = new InMemoryWorkerRepo()
  const abuse = new FakeAbuseChecks()
  const reports: unknown[] = []
  const deps: MediaChecksDeps = {
    repo,
    storage,
    abuseChecks: abuse,
    limits,
    download: makeDownloader(storage),
    report: (err) => reports.push(err),
    log: () => {},
    ...over,
  }
  return { deps, storage, repo, abuse, reports }
}

async function seedAsset(
  storage: FakeStorage,
  repo: InMemoryWorkerRepo,
  kind: "image" | "video",
  bytes: Uint8Array,
): Promise<{ id: string; uploadId: string; r2Key: string }> {
  const id = `media-${Math.random().toString(36).slice(2, 10)}`
  const uploadId = `up-${Math.random().toString(36).slice(2, 10)}`
  const r2Key = `uploads/2026/06/${id}`
  repo.seed({ id, uploadId, kind, r2Key })
  await storage.put(r2Key, Buffer.from(bytes), {
    contentType: kind === "video" ? "video/mp4" : "image/jpeg",
  })
  return { id, uploadId, r2Key }
}

describe("processMedia (pure core)", () => {
  it("never throws and returns rejected for every crafted bad input", async () => {
    const { deps } = makeDeps()
    const cases: { name: string; kind: "image" | "video"; bytes: Uint8Array }[] = [
      { name: "garbage", kind: "image", bytes: fx.makeGarbageImage() },
      { name: "textAsJpg", kind: "image", bytes: fx.makeTextAsJpg() },
      { name: "truncated", kind: "image", bytes: await fx.makeTruncatedImage() },
      { name: "pixelBomb", kind: "image", bytes: fx.makePixelBombPng() },
      { name: "empty", kind: "image", bytes: new Uint8Array(0) },
      { name: "nonVideoAsMp4", kind: "video", bytes: fx.makeNonVideoAsMp4() },
      { name: "garbageVideo", kind: "video", bytes: fx.makeGarbageImage() },
    ]
    for (const c of cases) {
      const res = await processMedia({ bytes: c.bytes, kind: c.kind }, deps)
      expect(res.status, `${c.name} should be rejected`).toBe("rejected")
      expect(res.note, `${c.name} should carry a note`).toBeTruthy()
      expect(res.processedBytes).toBeNull()
    }
  })

  it("rejects an oversize buffer before decoding", async () => {
    const { deps } = makeDeps()
    const res = await processMedia(
      { bytes: fx.makeOversize(limits.maxDownloadBytes), kind: "image" },
      deps,
    )
    expect(res.status).toBe("rejected")
    expect(res.note).toMatch(/exceeds cap/)
  })
})

describe("media.checks IMAGE path", () => {
  let env: ReturnType<typeof makeDeps>
  beforeEach(() => {
    env = makeDeps()
  })

  it("valid JPEG -> ready, EXIF/GPS stripped, thumbnail written, width/height/phash set", async () => {
    const input = await fx.makeValidJpegWithGps()
    const inGps = await exifr.gps(input)
    expect(inGps?.latitude).toBeCloseTo(37.7672, 3)

    const { id, uploadId, r2Key } = await seedAsset(env.storage, env.repo, "image", input)
    const status = await runMediaChecksJob(
      { mediaId: id, uploadId, r2Key, kind: "image" },
      env.deps,
    )
    expect(status).toBe("ready")

    const row = env.repo.get(id)!
    expect(row.status).toBe("ready")
    expect(row.width).toBe(64)
    expect(row.height).toBe(48)
    expect(typeof row.phash).toBe("string")
    expect((row.phash as string).length).toBe(16)
    expect(row.thumbKey).toBe(`thumbs/${r2Key}.jpg`)

    const processed = env.storage.get(r2Key)
    expect(processed).not.toBeNull()
    expect(env.storage.get(`processed/${r2Key}.img`)).toBeNull()
    const outGps = await exifr.gps(Buffer.from(processed!))
    expect(outGps?.latitude ?? null).toBeNull()
    expect(outGps?.longitude ?? null).toBeNull()

    const thumb = env.storage.get(`thumbs/${r2Key}.jpg`)
    expect(thumb).not.toBeNull()
    const thumbGps = await exifr.gps(Buffer.from(thumb!))
    expect(thumbGps?.latitude ?? null).toBeNull()
  })

  it("valid PNG -> ready with dimensions and a thumbnail", async () => {
    const input = await fx.makeValidPng()
    const { id, uploadId, r2Key } = await seedAsset(env.storage, env.repo, "image", input)
    const status = await runMediaChecksJob(
      { mediaId: id, uploadId, r2Key, kind: "image" },
      env.deps,
    )
    expect(status).toBe("ready")
    const row = env.repo.get(id)!
    expect(row.width).toBe(40)
    expect(row.height).toBe(30)
    expect(env.storage.get(`thumbs/${r2Key}.jpg`)).not.toBeNull()
  })

  it("NSFW over threshold -> held + abuse_flag reason nsfw (no throw)", async () => {
    const input = await fx.makeNsfwJpeg()
    const { id, uploadId, r2Key } = await seedAsset(env.storage, env.repo, "image", input)
    const status = await runMediaChecksJob(
      { mediaId: id, uploadId, r2Key, kind: "image" },
      env.deps,
    )
    expect(status).toBe("held")
    expect(env.repo.get(id)!.status).toBe("held")
    expect(env.repo.flags).toContainEqual({ subjectId: id, reason: "nsfw", source: "worker" })
  })

  it("M3: an NSFW hold on an authenticated report enqueues a high-priority moderation item", async () => {
    const input = await fx.makeNsfwJpeg()
    const id = "media-nsfw-rep"
    const uploadId = "up-nsfw-rep"
    const r2Key = `uploads/2026/06/${id}`
    env.repo.seed({ id, uploadId, kind: "image", r2Key, reportId: "report-123" })
    await env.storage.put(r2Key, Buffer.from(input), { contentType: "image/jpeg" })

    const status = await runMediaChecksJob({ mediaId: id, uploadId, r2Key, kind: "image" }, env.deps)
    expect(status).toBe("held")
    expect(env.repo.moderationEnqueues).toHaveLength(1)
    expect(env.repo.moderationEnqueues[0]).toMatchObject({
      reportId: "report-123",
      kind: "image",
    })
  })

  it("M3: a moderation-enqueue failure is non-fatal (the media hold still completes)", async () => {
    const input = await fx.makeNsfwJpeg()
    const id = "media-nsfw-fail"
    const uploadId = "up-nsfw-fail"
    const r2Key = `uploads/2026/06/${id}`
    env.repo.seed({ id, uploadId, kind: "image", r2Key, reportId: "report-456" })
    await env.storage.put(r2Key, Buffer.from(input), { contentType: "image/jpeg" })
    env.repo.failModerationEnqueue = new Error("moderation insert down")

    const status = await runMediaChecksJob({ mediaId: id, uploadId, r2Key, kind: "image" }, env.deps)
    expect(status).toBe("held")
    expect(env.repo.get(id)!.status).toBe("held")
  })

  it("M3: a held asset with NO reportId does not enqueue a moderation item", async () => {
    const input = await fx.makeNsfwJpeg()
    const { id, uploadId, r2Key } = await seedAsset(env.storage, env.repo, "image", input)
    await runMediaChecksJob({ mediaId: id, uploadId, r2Key, kind: "image" }, env.deps)
    expect(env.repo.moderationEnqueues).toHaveLength(0)
  })

  it("#43: a near-duplicate (repeated phash) is ALLOWED (ready, NOT held, no phash_dup flag)", async () => {
    const a = await fx.makeValidPng()
    const first = await seedAsset(env.storage, env.repo, "image", a)
    const s1 = await runMediaChecksJob(
      { mediaId: first.id, uploadId: first.uploadId, r2Key: first.r2Key, kind: "image" },
      env.deps,
    )
    expect(s1).toBe("ready")

    const second = await seedAsset(env.storage, env.repo, "image", a)
    const s2 = await runMediaChecksJob(
      { mediaId: second.id, uploadId: second.uploadId, r2Key: second.r2Key, kind: "image" },
      env.deps,
    )
    expect(s2).toBe("ready")
    expect(env.repo.get(second.id)!.status).toBe("ready")
    expect(env.repo.flags.filter((f) => f.reason === "phash_dup")).toHaveLength(0)
  })

  it("P0-2: re-processing the SAME asset does NOT mark it a near-duplicate of itself", async () => {
    const index = new Map<string, { phash: string; reportId: string | null }>()
    const findPhashDuplicate = (hash: string, opts?: { excludeAssetId?: string }) => {
      for (const [id, row] of index) {
        if (row.phash === hash && row.reportId !== null && id !== opts?.excludeAssetId) {
          return Promise.resolve({ dup: true, ofReportId: row.reportId })
        }
      }
      return Promise.resolve({ dup: false })
    }
    const env = makeDeps({ findPhashDuplicate })

    const input = await fx.makeValidPng()
    const { id, uploadId, r2Key } = await seedAsset(env.storage, env.repo, "image", input)
    env.repo.get(id)!.reportId = "report-self"

    const s1 = await runMediaChecksJob({ mediaId: id, uploadId, r2Key, kind: "image" }, env.deps)
    expect(s1).toBe("ready")
    const phash1 = env.repo.get(id)!.phash as string
    index.set(id, { phash: phash1, reportId: "report-self" })

    const s2 = await runMediaChecksJob({ mediaId: id, uploadId, r2Key, kind: "image" }, env.deps)
    expect(s2).toBe("ready")
    expect(env.repo.get(id)!.status).toBe("ready")
    expect(env.repo.flags.filter((f) => f.reason === "phash_dup")).toHaveLength(0)
  })

  it("#43: a DIFFERENT (cross-report) asset with the same phash is ALLOWED, not held", async () => {
    const index = new Map<string, { phash: string; reportId: string | null }>()
    const findPhashDuplicate = (hash: string, opts?: { excludeAssetId?: string }) => {
      for (const [id, row] of index) {
        if (row.phash === hash && row.reportId !== null && id !== opts?.excludeAssetId) {
          return Promise.resolve({ dup: true, ofReportId: row.reportId })
        }
      }
      return Promise.resolve({ dup: false })
    }
    const env = makeDeps({ findPhashDuplicate })

    const bytes = await fx.makeValidPng()
    const first = await seedAsset(env.storage, env.repo, "image", bytes)
    env.repo.get(first.id)!.reportId = "report-A"
    const s1 = await runMediaChecksJob(
      { mediaId: first.id, uploadId: first.uploadId, r2Key: first.r2Key, kind: "image" },
      env.deps,
    )
    expect(s1).toBe("ready")
    index.set(first.id, { phash: env.repo.get(first.id)!.phash as string, reportId: "report-A" })

    const second = await seedAsset(env.storage, env.repo, "image", bytes)
    env.repo.get(second.id)!.reportId = "report-B"
    const s2 = await runMediaChecksJob(
      { mediaId: second.id, uploadId: second.uploadId, r2Key: second.r2Key, kind: "image" },
      env.deps,
    )
    expect(s2).toBe("ready")
    expect(env.repo.get(second.id)!.status).toBe("ready")
    expect(env.repo.flags.filter((f) => f.reason === "phash_dup")).toHaveLength(0)
  })

  it("#43: a SIBLING asset with the same phash in the SAME report is NOT a near-duplicate", async () => {
    const index = new Map<string, { phash: string; reportId: string | null }>()
    const findPhashDuplicate = (
      hash: string,
      opts?: { excludeAssetId?: string; excludeReportId?: string },
    ) => {
      for (const [id, row] of index) {
        if (
          row.phash === hash &&
          row.reportId !== null &&
          id !== opts?.excludeAssetId &&
          row.reportId !== opts?.excludeReportId
        ) {
          return Promise.resolve({ dup: true, ofReportId: row.reportId })
        }
      }
      return Promise.resolve({ dup: false })
    }
    const env = makeDeps({ findPhashDuplicate })

    const bytes = await fx.makeValidPng()
    const first = await seedAsset(env.storage, env.repo, "image", bytes)
    env.repo.get(first.id)!.reportId = "report-shared"
    const s1 = await runMediaChecksJob(
      { mediaId: first.id, uploadId: first.uploadId, r2Key: first.r2Key, kind: "image" },
      env.deps,
    )
    expect(s1).toBe("ready")
    index.set(first.id, {
      phash: env.repo.get(first.id)!.phash as string,
      reportId: "report-shared",
    })

    const sibling = await seedAsset(env.storage, env.repo, "image", bytes)
    env.repo.get(sibling.id)!.reportId = "report-shared"
    const s2 = await runMediaChecksJob(
      { mediaId: sibling.id, uploadId: sibling.uploadId, r2Key: sibling.r2Key, kind: "image" },
      env.deps,
    )
    expect(s2).toBe("ready")
    expect(env.repo.get(sibling.id)!.status).toBe("ready")
    expect(env.repo.flags.filter((f) => f.reason === "phash_dup")).toHaveLength(0)

    const other = await seedAsset(env.storage, env.repo, "image", bytes)
    env.repo.get(other.id)!.reportId = "report-other"
    const s3 = await runMediaChecksJob(
      { mediaId: other.id, uploadId: other.uploadId, r2Key: other.r2Key, kind: "image" },
      env.deps,
    )
    expect(s3).toBe("ready")
    expect(env.repo.get(other.id)!.status).toBe("ready")
    expect(env.repo.flags.filter((f) => f.reason === "phash_dup")).toHaveLength(0)
  })

  it("each crafted bad image -> rejected row, no throw, GlitchTip notified", async () => {
    const bad: { name: string; bytes: Uint8Array }[] = [
      { name: "garbage", bytes: fx.makeGarbageImage() },
      { name: "textAsJpg", bytes: fx.makeTextAsJpg() },
      { name: "truncated", bytes: await fx.makeTruncatedImage() },
      { name: "pixelBomb", bytes: fx.makePixelBombPng() },
    ]
    for (const b of bad) {
      const local = makeDeps()
      const { id, uploadId, r2Key } = await seedAsset(local.storage, local.repo, "image", b.bytes)
      const status = await runMediaChecksJob(
        { mediaId: id, uploadId, r2Key, kind: "image" },
        local.deps,
      )
      expect(status, `${b.name}`).toBe("rejected")
      expect(local.repo.get(id)!.status, `${b.name}`).toBe("rejected")
      expect(local.reports.length, `${b.name} reported`).toBeGreaterThan(0)
      expect(local.storage.get(`processed/${r2Key}.img`)).toBeNull()
      expect(local.storage.get(r2Key)).not.toBeNull()
    }
  })

  it("oversize object is rejected at download (size cap) without decoding", async () => {
    const local = makeDeps()
    const big = fx.makeOversize(limits.maxDownloadBytes)
    const { id, uploadId, r2Key } = await seedAsset(local.storage, local.repo, "image", big)
    const status = await runMediaChecksJob(
      { mediaId: id, uploadId, r2Key, kind: "image" },
      local.deps,
    )
    expect(status).toBe("rejected")
    expect(local.repo.get(id)!.status).toBe("rejected")
  })
})

describe("media.checks VIDEO path", () => {
  let env: ReturnType<typeof makeDeps>
  beforeEach(() => {
    env = makeDeps()
  })

  it("valid h264 MP4 -> ffprobe sees h264, duration <= 30 -> ready, remuxed + location-free, thumb written", async () => {
    const input = await fx.makeValidMp4()
    const { id, uploadId, r2Key } = await seedAsset(env.storage, env.repo, "video", input)
    const status = await runMediaChecksJob(
      { mediaId: id, uploadId, r2Key, kind: "video" },
      env.deps,
    )
    expect(status).toBe("ready")

    const row = env.repo.get(id)!
    expect(row.status).toBe("ready")
    expect(row.codec).toBe("h264")
    expect(row.width).toBe(320)
    expect(row.height).toBe(240)

    const remuxed = env.storage.get(r2Key)
    expect(remuxed).not.toBeNull()
    expect(env.storage.get(`processed/${r2Key}.mp4`)).toBeNull()

    expect(row.thumbKey).toBe(`thumbs/${r2Key}.jpg`)
    expect(env.storage.get(`thumbs/${r2Key}.jpg`)).not.toBeNull()
  })

  it("F24: video NSFW scoring receives the DECODED frame JPEG, not the raw mp4 container bytes", async () => {
    let scoredBytes: Uint8Array | null = null
    ;(env.abuse as { nsfwScore: (b: Uint8Array) => Promise<number> }).nsfwScore = (b) => {
      scoredBytes = b
      return Promise.resolve(0)
    }
    const input = await fx.makeValidMp4()
    const { id, uploadId, r2Key } = await seedAsset(env.storage, env.repo, "video", input)
    const status = await runMediaChecksJob(
      { mediaId: id, uploadId, r2Key, kind: "video" },
      env.deps,
    )

    expect(status).toBe("ready")
    expect(scoredBytes).not.toBeNull()
    expect(scoredBytes![0]).toBe(0xff)
    expect(scoredBytes![1]).toBe(0xd8)
    expect(scoredBytes!.byteLength).not.toBe(input.byteLength)
  })

  it("audio-only MP4 (no video stream) -> rejected", async () => {
    const input = await fx.makeAudioOnlyMp4()
    const { id, uploadId, r2Key } = await seedAsset(env.storage, env.repo, "video", input)
    const status = await runMediaChecksJob(
      { mediaId: id, uploadId, r2Key, kind: "video" },
      env.deps,
    )
    expect(status).toBe("rejected")
    expect(env.repo.get(id)!.status).toBe("rejected")
  })

  it("non-video bytes labeled video -> ffprobe fails -> rejected, no throw", async () => {
    const input = fx.makeNonVideoAsMp4()
    const { id, uploadId, r2Key } = await seedAsset(env.storage, env.repo, "video", input)
    const status = await runMediaChecksJob(
      { mediaId: id, uploadId, r2Key, kind: "video" },
      env.deps,
    )
    expect(status).toBe("rejected")
    expect(env.repo.get(id)!.status).toBe("rejected")
    expect(env.reports.length).toBeGreaterThan(0)
  })
})

describe("media.checks orchestration robustness", () => {
  it("missing asset row -> rejected, no throw", async () => {
    const env = makeDeps()
    const status = await runMediaChecksJob(
      { mediaId: "nope", uploadId: "nope", r2Key: "uploads/x", kind: "image" },
      env.deps,
    )
    expect(status).toBe("rejected")
  })

  it("persist failure on a good image THROWS (infra retry), leaving the row non-terminal (NOT rejected)", async () => {
    const env = makeDeps()
    const input = await fx.makeValidPng()
    const { id, uploadId, r2Key } = await seedAsset(env.storage, env.repo, "image", input)
    env.repo.applyResult = () => Promise.reject(new Error("db down"))

    await expect(
      runMediaChecksJob({ mediaId: id, uploadId, r2Key, kind: "image" }, env.deps),
    ).rejects.toBeInstanceOf(MediaInfraError)
    expect(env.repo.get(id)!.status).toBe("validating")
    expect(env.reports.length).toBeGreaterThan(0)
  })

  it("#39 infra: a StorageUnavailableError on download THROWS (retry), media NOT rejected", async () => {
    const env = makeDeps()
    const id = "media-missing-bytes"
    const uploadId = "up-missing-bytes"
    const r2Key = `uploads/2026/06/${id}`
    env.repo.seed({ id, uploadId, kind: "image", r2Key })

    await expect(
      runMediaChecksJob({ mediaId: id, uploadId, r2Key, kind: "image" }, env.deps),
    ).rejects.toBeInstanceOf(MediaInfraError)
    expect(env.repo.get(id)!.status).toBe("validating")
    expect(env.reports.length).toBeGreaterThan(0)
    expect(env.storage.get(r2Key)).toBeNull()
  })

  it("bad input: a DownloadTooLargeError still -> rejected (unchanged), no throw", async () => {
    const env = makeDeps()
    const id = "media-too-large"
    const uploadId = "up-too-large"
    const r2Key = `uploads/2026/06/${id}`
    env.repo.seed({ id, uploadId, kind: "image", r2Key })
    const download: DownloadFn = () => Promise.reject(new DownloadTooLargeError(limits.maxDownloadBytes))

    const status = await runMediaChecksJob(
      { mediaId: id, uploadId, r2Key, kind: "image" },
      { ...env.deps, download },
    )
    expect(status).toBe("rejected")
    expect(env.repo.get(id)!.status).toBe("rejected")
    expect(env.reports.length).toBeGreaterThan(0)
  })

  it("infra: an explicit StorageUnavailableError from the downloader THROWS (retry), not reject", async () => {
    const env = makeDeps()
    const id = "media-storage-5xx"
    const uploadId = "up-storage-5xx"
    const r2Key = `uploads/2026/06/${id}`
    env.repo.seed({ id, uploadId, kind: "image", r2Key })
    const download: DownloadFn = () =>
      Promise.reject(new StorageUnavailableError(r2Key, "HTTP 503"))

    await expect(
      runMediaChecksJob({ mediaId: id, uploadId, r2Key, kind: "image" }, { ...env.deps, download }),
    ).rejects.toBeInstanceOf(MediaInfraError)
    expect(env.repo.get(id)!.status).toBe("validating")
  })

  it("infra: a DB read (load) failure THROWS (retry) rather than reporting a misleading rejected", async () => {
    const env = makeDeps()
    env.repo.findById = () => Promise.reject(new Error("connection reset"))
    env.repo.findByUploadId = () => Promise.reject(new Error("connection reset"))
    await expect(
      runMediaChecksJob({ mediaId: "x", uploadId: "y", r2Key: "uploads/x", kind: "image" }, env.deps),
    ).rejects.toBeInstanceOf(MediaInfraError)
  })

  it("P2-1: the wall-clock budget bounds a wedged DOWNLOAD -> THROWS (infra retry, no hang)", async () => {
    const tightLimits: WorkerLimits = { ...limits, jobTimeoutMs: 50 }
    let downloadResolved = false
    const env = makeDeps({
      limits: tightLimits,
      download: () =>
        new Promise<Uint8Array>((resolve) => {
          setTimeout(() => {
            downloadResolved = true
            resolve(new Uint8Array([1, 2, 3]))
          }, 5_000).unref?.()
        }),
    })
    const input = await fx.makeValidPng()
    const { id, uploadId, r2Key } = await seedAsset(env.storage, env.repo, "image", input)

    const start = Date.now()
    await expect(
      runMediaChecksJob({ mediaId: id, uploadId, r2Key, kind: "image" }, env.deps),
    ).rejects.toBeInstanceOf(MediaInfraError)
    const elapsed = Date.now() - start

    expect(elapsed).toBeLessThan(2_000)
    expect(downloadResolved).toBe(false)
    expect(env.repo.get(id)?.status).toBe("validating")
    expect(env.reports.length).toBeGreaterThan(0)
  })

  it("F14: a per-job timeout ABORTS the in-flight download via the caller-supplied AbortSignal", async () => {
    const tightLimits: WorkerLimits = { ...limits, jobTimeoutMs: 50 }
    let sawAbort = false
    const env = makeDeps({
      limits: tightLimits,
      download: (_r2Key, _maxBytes, signal) =>
        new Promise<Uint8Array>((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            sawAbort = true
            reject(new Error("download aborted by job timeout"))
          })
        }),
    })
    const input = await fx.makeValidPng()
    const { id, uploadId, r2Key } = await seedAsset(env.storage, env.repo, "image", input)

    await expect(
      runMediaChecksJob({ mediaId: id, uploadId, r2Key, kind: "image" }, env.deps),
    ).rejects.toBeInstanceOf(MediaInfraError)

    expect(sawAbort).toBe(true)
  })

  it("P2-1: the wall-clock budget REJECTS a wedged PROCESS (no hang, no infra throw for bad bytes)", async () => {
    const tightLimits: WorkerLimits = { ...limits, jobTimeoutMs: 50 }
    const env = makeDeps({ limits: tightLimits })
    const input = await fx.makeValidPng()
    const { id, uploadId, r2Key } = await seedAsset(env.storage, env.repo, "image", input)
    ;(env.abuse as { nsfwScore: (b: Uint8Array) => Promise<number> }).nsfwScore = () =>
      new Promise<number>(() => {})

    const start = Date.now()
    const status = await runMediaChecksJob({ mediaId: id, uploadId, r2Key, kind: "image" }, env.deps)
    const elapsed = Date.now() - start

    expect(status).toBe("rejected")
    expect(elapsed).toBeLessThan(2_000)
    expect(env.repo.get(id)!.status).toBe("rejected")
    expect(env.reports.length).toBeGreaterThan(0)
  })

  it("parsePayload rejects malformed payloads", () => {
    expect(parsePayload(null)).toBeNull()
    expect(parsePayload({ mediaId: "a", uploadId: "b", r2Key: "c", kind: "audio" })).toBeNull()
    expect(parsePayload({ mediaId: "a", uploadId: "b", r2Key: "c", kind: "image" })).toEqual({
      mediaId: "a",
      uploadId: "b",
      r2Key: "c",
      kind: "image",
    })
  })
})

describe("media.checks with the REAL AbuseChecks (default-flag PUBLISH path)", () => {
  function realDeps(): { deps: MediaChecksDeps; storage: FakeStorage; repo: InMemoryWorkerRepo } {
    const storage = new FakeStorage()
    const repo = new InMemoryWorkerRepo()
    const abuse = new RealAbuseChecks({
      perceptualHash: (bytes: Uint8Array) => perceptualHash(bytes, limits),
      log: () => {},
    })
    const deps: MediaChecksDeps = {
      repo,
      storage,
      abuseChecks: abuse,
      limits,
      download: makeDownloader(storage),
      report: () => {},
      log: () => {},
    }
    return { deps, storage, repo }
  }

  it("M9: a clean JPEG -> READY but FLAGGED (no NSFW model configured = no verdict, not an all-clear)", async () => {
    const { deps, storage, repo } = realDeps()
    const input = await fx.makeValidJpegWithGps()
    const id = `media-real-1`
    const uploadId = `up-real-1`
    const r2Key = `uploads/2026/06/${id}`
    repo.seed({ id, uploadId, kind: "image", r2Key })
    await storage.put(r2Key, Buffer.from(input), { contentType: "image/jpeg" })

    const status = await runMediaChecksJob({ mediaId: id, uploadId, r2Key, kind: "image" }, deps)

    expect(status).toBe("ready")
    const row = repo.get(id)!
    expect(row.status).toBe("ready")
    expect((row.phash as string)).toMatch(/^[0-9a-f]{16}$/)
    expect(row.thumbKey).toBe(`thumbs/${r2Key}.jpg`)
    // M9: the NSFW gate was INERT in production — no model is vendored, USE_REAL_NSFW defaults false,
    // so nsfwScore always returned 0 and every unauthenticated upload auto-published with the entire
    // held/review branch dead. A missing scorer now raises the flag so the moderation queue actually
    // receives the asset; MEDIA_UNSCORED_POLICY=hold makes it fail fully closed.
    expect(repo.flags).toHaveLength(1)
    expect(repo.flags[0]).toMatchObject({ subjectId: id, reason: "nsfw" })
  })

  it("M9: a clean PNG -> READY, flagged for review while no NSFW model is configured", async () => {
    const { deps, storage, repo } = realDeps()
    const input = await fx.makeValidPng()
    const id = `media-real-2`
    const uploadId = `up-real-2`
    const r2Key = `uploads/2026/06/${id}`
    repo.seed({ id, uploadId, kind: "image", r2Key })
    await storage.put(r2Key, Buffer.from(input), { contentType: "image/png" })

    const status = await runMediaChecksJob({ mediaId: id, uploadId, r2Key, kind: "image" }, deps)
    expect(status).toBe("ready")
    expect(repo.get(id)!.status).toBe("ready")
    expect(repo.flags).toHaveLength(1)
    expect(repo.flags[0]).toMatchObject({ subjectId: id, reason: "nsfw" })
  })

  it("M9: MEDIA_UNSCORED_POLICY=hold fails CLOSED — an unscored asset is HELD, not published", async () => {
    const { deps, storage, repo } = realDeps()
    const holdDeps: MediaChecksDeps = {
      ...deps,
      limits: { ...limits, nsfwUnscoredPolicy: "hold" },
    }
    const input = await fx.makeValidPng()
    const id = `media-real-hold`
    const uploadId = `up-real-hold`
    const r2Key = `uploads/2026/06/${id}`
    repo.seed({ id, uploadId, kind: "image", r2Key })
    await storage.put(r2Key, Buffer.from(input), { contentType: "image/png" })

    const status = await runMediaChecksJob({ mediaId: id, uploadId, r2Key, kind: "image" }, holdDeps)
    expect(status).toBe("held")
    expect(repo.get(id)!.status).toBe("held")
    expect(repo.flags[0]).toMatchObject({ subjectId: id, reason: "nsfw" })
  })

  it("a real NSFW POSITIVE (model returns high) -> HELD + abuse_flag nsfw", async () => {
    const storage = new FakeStorage()
    const repo = new InMemoryWorkerRepo()
    const abuse = new RealAbuseChecks({
      useRealNsfw: true,
      nsfwModel: () => Promise.resolve(0.99),
      perceptualHash: (bytes: Uint8Array) => perceptualHash(bytes, limits),
      log: () => {},
    })
    const deps: MediaChecksDeps = {
      repo,
      storage,
      abuseChecks: abuse,
      limits,
      download: makeDownloader(storage),
      report: () => {},
      log: () => {},
    }
    const input = await fx.makeValidPng()
    const id = `media-real-nsfw`
    const uploadId = `up-real-nsfw`
    const r2Key = `uploads/2026/06/${id}`
    repo.seed({ id, uploadId, kind: "image", r2Key })
    await storage.put(r2Key, Buffer.from(input), { contentType: "image/png" })

    const status = await runMediaChecksJob({ mediaId: id, uploadId, r2Key, kind: "image" }, deps)
    expect(status).toBe("held")
    expect(repo.get(id)!.status).toBe("held")
    expect(repo.flags).toContainEqual({ subjectId: id, reason: "nsfw", source: "worker" })
  })

  it("#43: a near-duplicate (injected lookup reports dup) is ALLOWED (ready, no phash_dup flag)", async () => {
    const storage = new FakeStorage()
    const repo = new InMemoryWorkerRepo()
    const abuse = new RealAbuseChecks({
      perceptualHash: (bytes: Uint8Array) => perceptualHash(bytes, limits),
      findPhashDuplicate: () => Promise.resolve({ dup: true, ofReportId: "prior-report" }),
      log: () => {},
    })
    const deps: MediaChecksDeps = {
      repo,
      storage,
      abuseChecks: abuse,
      limits,
      download: makeDownloader(storage),
      report: () => {},
      log: () => {},
    }
    const input = await fx.makeValidPng()
    const id = `media-real-dup`
    const uploadId = `up-real-dup`
    const r2Key = `uploads/2026/06/${id}`
    repo.seed({ id, uploadId, kind: "image", r2Key })
    await storage.put(r2Key, Buffer.from(input), { contentType: "image/png" })

    const status = await runMediaChecksJob({ mediaId: id, uploadId, r2Key, kind: "image" }, deps)
    expect(status).toBe("ready")
    expect(repo.get(id)!.status).toBe("ready")
    expect(repo.flags.filter((f) => f.reason === "phash_dup")).toHaveLength(0)
  })
})

afterEach(() => {
})
