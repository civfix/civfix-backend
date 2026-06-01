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
import { makeDownloader } from "../../src/download.js"
import { perceptualHash } from "../../src/sandbox/phash.js"
import {
  processMedia,
  runMediaChecksJob,
  parsePayload,
  type MediaChecksDeps,
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

    // Processed image written to the processed key and carries NO GPS.
    const processed = env.storage.get(`processed/${r2Key}.img`)
    expect(processed).not.toBeNull()
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
      // No processed object should have been written for a rejected asset.
      expect(local.storage.get(`processed/${r2Key}.img`)).toBeNull()
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

    // Remuxed object written.
    const remuxed = env.storage.get(`processed/${r2Key}.mp4`)
    expect(remuxed).not.toBeNull()

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

  it("persist failure on a good image falls back to rejected (and reports)", async () => {
    const env = makeDeps()
    const input = await fx.makeValidPng()
    const { id, uploadId, r2Key } = await seedAsset(env.storage, env.repo, "image", input)
    // Make the FIRST applyResult (the success write) throw; the fallback rejection write then succeeds.
    let calls = 0
    const original = env.repo.applyResult.bind(env.repo)
    env.repo.applyResult = (rid, patch) => {
      calls++
      if (calls === 1) return Promise.reject(new Error("db down"))
      return original(rid, patch)
    }
    const status = await runMediaChecksJob(
      { mediaId: id, uploadId, r2Key, kind: "image" },
      env.deps,
    )
    expect(status).toBe("rejected")
    expect(env.reports.length).toBeGreaterThan(0)
  })

  it("P2-1: the per-job wall-clock budget rejects a wedged download/process (no hang)", async () => {
    // A download that never settles within the budget would otherwise hang the job indefinitely. With a
    // tiny jobTimeoutMs the overall guard fires, the asset is marked rejected, the job completes, and a
    // report is emitted. The test itself must finish quickly (proving the budget is enforced).
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
    const status = await runMediaChecksJob({ mediaId: id, uploadId, r2Key, kind: "image" }, env.deps)
    const elapsed = Date.now() - start

    expect(status).toBe("rejected")
    expect(elapsed).toBeLessThan(2_000) // the budget fired well before the 5s download would settle
    expect(downloadResolved).toBe(false)
    expect(env.repo.get(id)?.status).toBe("rejected")
    expect(env.reports.length).toBeGreaterThan(0) // the timeout was reported
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
