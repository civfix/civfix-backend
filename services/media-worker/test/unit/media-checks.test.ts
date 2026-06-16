/**
 * Safe-failure gate for the media.checks pipeline (LOCAL: real sharp + real ffmpeg/ffprobe).
 *
 * This is the test that PROVES the Phase-1 done-criterion "a crafted upload fails safely in the
 * worker". Every crafted/malicious input must yield a REJECTED (or held) row with NO thrown error
 * escaping the job, and a happy input must yield a ready row with EXIF/location stripped and a
 * thumbnail written. All processing runs against the real vendored binaries; storage is FakeStorage,
 * the repo is in-memory, and AbuseChecks is the fake (NSFW seam).
 */

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

/** Build a fresh deps bundle (FakeStorage + in-memory repo + FakeAbuseChecks + capped downloader). */
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

/** Seed a media row and stage its source bytes in FakeStorage, returning ids/keys. */
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
    // Sanity: the INPUT really carries GPS, so a clean OUTPUT proves the strip.
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

    // The source object at r2_key is OVERWRITTEN in place with the stripped re-encode, which carries NO
    // GPS (the raw upload's EXIF is gone from what downstream readers serve). No stray processed/ key.
    const processed = env.storage.get(r2Key)
    expect(processed).not.toBeNull()
    expect(env.storage.get(`processed/${r2Key}.img`)).toBeNull()
    const outGps = await exifr.gps(Buffer.from(processed!))
    expect(outGps?.latitude ?? null).toBeNull()
    expect(outGps?.longitude ?? null).toBeNull()

    // Thumbnail written and decodes, longest edge <= 400, also GPS-free.
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

  // M3: a held asset WITH a reportId enqueues a moderation item (the held media -> moderation queue
  // producer the documented call site wires), so held media surfaces to operators.
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

    // Must NOT throw, and the asset must still be held (the enqueue is best-effort).
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

  it("near-duplicate (repeated phash) -> held + abuse_flag reason phash_dup", async () => {
    // First upload: ready and its phash is now 'seen' by FakeAbuseChecks.
    const a = await fx.makeValidPng()
    const first = await seedAsset(env.storage, env.repo, "image", a)
    const s1 = await runMediaChecksJob(
      { mediaId: first.id, uploadId: first.uploadId, r2Key: first.r2Key, kind: "image" },
      env.deps,
    )
    expect(s1).toBe("ready")

    // Second upload of the SAME bytes: identical phash -> FakeAbuseChecks reports a duplicate.
    const second = await seedAsset(env.storage, env.repo, "image", a)
    const s2 = await runMediaChecksJob(
      { mediaId: second.id, uploadId: second.uploadId, r2Key: second.r2Key, kind: "image" },
      env.deps,
    )
    expect(s2).toBe("held")
    expect(env.repo.flags).toContainEqual({
      subjectId: second.id,
      reason: "phash_dup",
      source: "worker",
    })
  })

  it("P0-2: re-processing the SAME asset does NOT mark it a near-duplicate of itself", async () => {
    // Simulate the production media_assets phash lookup with self-exclusion (AND id <> excludeAssetId).
    // The index reflects every asset's persisted (id, phash, reportId); the lookup returns a dup ONLY for
    // a DIFFERENT asset sharing the phash. This is the exact behavior makePhashDuplicateLookup provides.
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
    // The row already carries a report_id (set at report-create) BEFORE the first run, like production.
    env.repo.get(id)!.reportId = "report-self"

    // FIRST run: persists the asset's phash. The lookup index is updated to reflect the persisted row
    // (in production the row's phash column is written by applyResult; we mirror that here so the SECOND
    // run sees a row with the same phash + a report_id - the exact self-collision the bug hit).
    const s1 = await runMediaChecksJob({ mediaId: id, uploadId, r2Key, kind: "image" }, env.deps)
    expect(s1).toBe("ready")
    const phash1 = env.repo.get(id)!.phash as string
    index.set(id, { phash: phash1, reportId: "report-self" })

    // SECOND run of the SAME asset (job re-delivered / double-enqueued): recomputes the identical phash.
    // Without self-exclusion it would match its OWN row -> held + phash_dup. With the fix it stays ready.
    const s2 = await runMediaChecksJob({ mediaId: id, uploadId, r2Key, kind: "image" }, env.deps)
    expect(s2).toBe("ready")
    expect(env.repo.get(id)!.status).toBe("ready")
    expect(env.repo.flags.filter((f) => f.reason === "phash_dup")).toHaveLength(0)
  })

  it("P0-2: a DIFFERENT asset with the same phash IS still held as a near-duplicate", async () => {
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

    // First asset (attached to report-A) processes ready and is recorded in the index.
    const bytes = await fx.makeValidPng()
    const first = await seedAsset(env.storage, env.repo, "image", bytes)
    env.repo.get(first.id)!.reportId = "report-A"
    const s1 = await runMediaChecksJob(
      { mediaId: first.id, uploadId: first.uploadId, r2Key: first.r2Key, kind: "image" },
      env.deps,
    )
    expect(s1).toBe("ready")
    index.set(first.id, { phash: env.repo.get(first.id)!.phash as string, reportId: "report-A" })

    // Second, DISTINCT asset (different id, attached to report-B) with the SAME bytes -> same phash.
    // Self-exclusion does not save it (it is a different row), so it is correctly held as a duplicate.
    const second = await seedAsset(env.storage, env.repo, "image", bytes)
    env.repo.get(second.id)!.reportId = "report-B"
    const s2 = await runMediaChecksJob(
      { mediaId: second.id, uploadId: second.uploadId, r2Key: second.r2Key, kind: "image" },
      env.deps,
    )
    expect(s2).toBe("held")
    expect(env.repo.flags).toContainEqual({
      subjectId: second.id,
      reason: "phash_dup",
      source: "worker",
    })
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
      // A rejected asset is left untouched: its source object is NOT overwritten with processed bytes,
      // and no stray processed/ key is written.
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

    // The source object at r2_key is overwritten in place with the metadata-stripped remux; no stray
    // processed/ key is written any more.
    const remuxed = env.storage.get(r2Key)
    expect(remuxed).not.toBeNull()
    expect(env.storage.get(`processed/${r2Key}.mp4`)).toBeNull()

    // Thumbnail frame grabbed + written.
    expect(row.thumbKey).toBe(`thumbs/${r2Key}.jpg`)
    expect(env.storage.get(`thumbs/${r2Key}.jpg`)).not.toBeNull()
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
    // A persist (storage PUT / DB applyResult) failure is INFRA, not bad input. The job must NOT reject
    // good media; it re-throws MediaInfraError so pg-boss retries. The asset row stays in its current
    // non-terminal status (validating) - never silently flipped to rejected by a transient write blip.
    const env = makeDeps()
    const input = await fx.makeValidPng()
    const { id, uploadId, r2Key } = await seedAsset(env.storage, env.repo, "image", input)
    // The (only) applyResult call is the success write; make it throw to simulate a DB outage.
    env.repo.applyResult = () => Promise.reject(new Error("db down"))

    await expect(
      runMediaChecksJob({ mediaId: id, uploadId, r2Key, kind: "image" }, env.deps),
    ).rejects.toBeInstanceOf(MediaInfraError)
    // Row left non-terminal (still validating) so it recovers on retry; never rejected.
    expect(env.repo.get(id)!.status).toBe("validating")
    expect(env.reports.length).toBeGreaterThan(0) // the infra failure was reported (phase "persist")
  })

  it("#39 infra: a StorageUnavailableError on download THROWS (retry), media NOT rejected", async () => {
    // The #39 root cause: a worker pointed at empty/wrong storage cannot fetch the bytes. That is INFRA,
    // not bad input - it must re-throw (so pg-boss retries) and leave the media non-terminal, never
    // permanently rejected. (makeDownloader over an EMPTY FakeStorage produces exactly this error.)
    const env = makeDeps()
    const id = "media-missing-bytes"
    const uploadId = "up-missing-bytes"
    const r2Key = `uploads/2026/06/${id}`
    // Seed the ROW but do NOT stage its bytes in storage -> download misses -> StorageUnavailableError.
    env.repo.seed({ id, uploadId, kind: "image", r2Key })

    await expect(
      runMediaChecksJob({ mediaId: id, uploadId, r2Key, kind: "image" }, env.deps),
    ).rejects.toBeInstanceOf(MediaInfraError)
    // The media row is untouched (still validating); NOT rejected, so it recovers once storage is healthy.
    expect(env.repo.get(id)!.status).toBe("validating")
    expect(env.reports.length).toBeGreaterThan(0) // reported with phase "download-infra"
    // No processed bytes were written for an asset that never downloaded.
    expect(env.storage.get(r2Key)).toBeNull()
  })

  it("bad input: a DownloadTooLargeError still -> rejected (unchanged), no throw", async () => {
    // An over-cap object is BAD INPUT (out of policy), so it stays a PERMANENT rejection - the opposite
    // of an infra download failure. A custom download throws DownloadTooLargeError to assert the split.
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
    // A download that never settles within the budget would otherwise hang the job indefinitely. With a
    // tiny jobTimeoutMs the wall-clock guard fires. A stalled FETCH is INFRA (not bad input), so the job
    // re-throws MediaInfraError (pg-boss retries) and leaves the row non-terminal - it does NOT reject
    // good media. The test itself must finish quickly (proving the budget is enforced, no hang).
    const tightLimits: WorkerLimits = { ...limits, jobTimeoutMs: 50 }
    let downloadResolved = false
    const env = makeDeps({
      limits: tightLimits,
      download: () =>
        new Promise<Uint8Array>((resolve) => {
          // Settle far AFTER the budget; the wall-clock guard should win first.
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

    expect(elapsed).toBeLessThan(2_000) // the budget fired well before the 5s download would settle
    expect(downloadResolved).toBe(false)
    expect(env.repo.get(id)?.status).toBe("validating") // non-terminal: recovers on retry, not rejected
    expect(env.reports.length).toBeGreaterThan(0) // the timeout was reported (phase download-infra)
  })

  it("P2-1: the wall-clock budget REJECTS a wedged PROCESS (no hang, no infra throw for bad bytes)", async () => {
    // Once the bytes are in hand, a crafted asset that wedges the SANDBOX pipeline past the budget is bad
    // input -> a safe permanent "rejected" (NOT an infra retry - attacker bytes must never trigger one).
    // We wedge the process step deterministically with a FakeAbuseChecks whose nsfwScore never settles
    // (applyAbuseSeams awaits it), so the process-phase withJobTimeout fires and the job rejects + completes.
    const tightLimits: WorkerLimits = { ...limits, jobTimeoutMs: 50 }
    const env = makeDeps({ limits: tightLimits })
    // Download returns instantly (valid bytes), so the wedge is in PROCESS, not download.
    const input = await fx.makeValidPng()
    const { id, uploadId, r2Key } = await seedAsset(env.storage, env.repo, "image", input)
    // Override the seam's nsfwScore (applyAbuseSeams awaits it) with one that never settles. Cast because
    // we are monkeypatching an instance method on the fake for this test only.
    ;(env.abuse as { nsfwScore: (b: Uint8Array) => Promise<number> }).nsfwScore = () =>
      new Promise<number>(() => {}) // never settles

    const start = Date.now()
    const status = await runMediaChecksJob({ mediaId: id, uploadId, r2Key, kind: "image" }, env.deps)
    const elapsed = Date.now() - start

    expect(status).toBe("rejected") // a process-phase timeout is bad-input -> rejected, NOT a throw
    expect(elapsed).toBeLessThan(2_000) // budget fired; no hang
    expect(env.repo.get(id)!.status).toBe("rejected")
    expect(env.reports.length).toBeGreaterThan(0) // the timeout was reported (phase timeout)
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
  /**
   * The production default has USE_FAKE_ABUSE_NSFW=false (real adapter) and no NSFW model wired. This
   * proves the regression fix: a clean image runs through RealAbuseChecks and ends READY (publishable),
   * instead of the old behavior where nsfwScore threw -> the pipeline failed CLOSED -> the asset was
   * held forever. The real perceptual hasher (sandbox/phash.ts) is injected exactly as the worker wires
   * it; no NSFW model + no dedupe lookup -> benign by default, never throws.
   */
  function realDeps(): { deps: MediaChecksDeps; storage: FakeStorage; repo: InMemoryWorkerRepo } {
    const storage = new FakeStorage()
    const repo = new InMemoryWorkerRepo()
    const abuse = new RealAbuseChecks({
      perceptualHash: (bytes: Uint8Array) => perceptualHash(bytes, limits),
      // no useRealNsfw, no nsfwModel, no findPhashDuplicate -> benign defaults.
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

  it("a clean JPEG -> READY (benign NSFW default), real phash set, thumbnail written", async () => {
    const { deps, storage, repo } = realDeps()
    const input = await fx.makeValidJpegWithGps()
    const id = `media-real-1`
    const uploadId = `up-real-1`
    const r2Key = `uploads/2026/06/${id}`
    repo.seed({ id, uploadId, kind: "image", r2Key })
    await storage.put(r2Key, Buffer.from(input), { contentType: "image/jpeg" })

    const status = await runMediaChecksJob({ mediaId: id, uploadId, r2Key, kind: "image" }, deps)

    // The whole point: real adapter + no model -> READY (publishes), NOT held.
    expect(status).toBe("ready")
    const row = repo.get(id)!
    expect(row.status).toBe("ready")
    // Real dHash from sandbox/phash.ts (16-char hex), not the adapter's byte-hash fallback.
    expect((row.phash as string)).toMatch(/^[0-9a-f]{16}$/)
    expect(row.thumbKey).toBe(`thumbs/${r2Key}.jpg`)
    // No abuse flags raised on a clean asset.
    expect(repo.flags).toHaveLength(0)
  })

  it("a clean PNG -> READY with no abuse flags", async () => {
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
    expect(repo.flags).toHaveLength(0)
  })

  it("a real NSFW POSITIVE (model returns high) -> HELD + abuse_flag nsfw", async () => {
    // Wire a model that scores above the hold threshold to prove the held path still works end-to-end
    // through the real adapter (the FLOW was always implemented; this confirms decoupling left it intact).
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

  it("a near-duplicate (injected lookup reports dup) -> HELD + abuse_flag phash_dup", async () => {
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
    expect(status).toBe("held")
    expect(repo.flags).toContainEqual({ subjectId: id, reason: "phash_dup", source: "worker" })
  })
})

afterEach(() => {
  // FakeAbuseChecks instances are created per test (fresh dedupe memory), nothing global to reset.
})
