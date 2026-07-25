/**
 * VIDEO moderation policy branches (jobs/media-pipeline.ts processVideoBytes).
 *
 * The suite's only video fixture was a 1s h264 MP4 on the happy path, so three moderation-relevant
 * outcomes had no regression net at all:
 *   - the CODEC ALLOWLIST (a real, decodable video in a codec we refuse to serve),
 *   - the DURATION BOUND (the cap that stops a 10-minute upload from being remuxed and published),
 *   - the FRAME-GRAB FAILURE hold (no decodable frame => nothing was NSFW-scored => must NOT publish).
 * Deleting any of those three checks would have kept the suite green.
 *
 * Real ffmpeg/ffprobe throughout. The one stub is grabFrameJpeg in the last block: the branch under test
 * is the pipeline's decision when frame extraction fails, and a fixture that remuxes but cannot yield a
 * single frame is not reliably craftable. remuxStripMetadata stays real even there.
 */

import { beforeEach, describe, expect, it, vi } from "vitest"
import { FakeStorage, FakeAbuseChecks } from "@civfix/shared/fakes"
import { loadLimits, type WorkerLimits } from "../../src/config.js"
import { makeDownloader } from "../../src/download.js"
import { InMemoryWorkerRepo } from "../helpers/in-memory-repo.js"
import * as fx from "../fixtures/make.js"

/** Mutable switch for the grabFrameJpeg stub, hoisted so the vi.mock factory can close over it. */
const stub = vi.hoisted(() => ({ grabFrameError: null as Error | null }))

vi.mock("../../src/sandbox/ffmpeg-remux.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/sandbox/ffmpeg-remux.js")>()
  return {
    ...actual,
    grabFrameJpeg: (bytes: Uint8Array, atSec: number, limits: WorkerLimits) =>
      stub.grabFrameError
        ? Promise.reject(stub.grabFrameError)
        : actual.grabFrameJpeg(bytes, atSec, limits),
  }
})

// Imported AFTER the mock declaration on purpose: vi.mock is hoisted, so these see the patched module.
const { processMedia } = await import("../../src/jobs/media-pipeline.js")
const { runMediaChecksJob } = await import("../../src/jobs/media-checks.js")
type MediaChecksDeps = import("../../src/jobs/media-checks.js").MediaChecksDeps

const limits: WorkerLimits = loadLimits({})

function makeEnv(over?: Partial<MediaChecksDeps>): {
  deps: MediaChecksDeps
  storage: FakeStorage
  repo: InMemoryWorkerRepo
  reports: unknown[]
} {
  const storage = new FakeStorage()
  const repo = new InMemoryWorkerRepo()
  const reports: unknown[] = []
  const deps: MediaChecksDeps = {
    repo,
    storage,
    abuseChecks: new FakeAbuseChecks(),
    limits,
    download: makeDownloader(storage),
    report: (err) => reports.push(err),
    log: () => {},
    ...over,
  }
  return { deps, storage, repo, reports }
}

async function seedVideo(
  storage: FakeStorage,
  repo: InMemoryWorkerRepo,
  bytes: Uint8Array,
  over: { reportId?: string } = {},
): Promise<{ id: string; uploadId: string; r2Key: string }> {
  const id = `media-${Math.random().toString(36).slice(2, 10)}`
  const uploadId = `up-${Math.random().toString(36).slice(2, 10)}`
  const r2Key = `uploads/2026/06/${id}`
  repo.seed({ id, uploadId, kind: "video", r2Key, reportId: over.reportId ?? null })
  await storage.put(r2Key, Buffer.from(bytes), { contentType: "video/mp4" })
  return { id, uploadId, r2Key }
}

beforeEach(() => {
  stub.grabFrameError = null
})

describe("video codec allowlist (ALLOWED_VIDEO_CODECS)", () => {
  it("REJECTS a decodable mpeg4 video (allowlist is h264/hevc, not 'anything ffprobe reads')", async () => {
    const bytes = await fx.makeMpeg4Mp4()
    const { deps } = makeEnv()

    const res = await processMedia({ bytes, kind: "video" }, deps)

    expect(res.status).toBe("rejected")
    expect(res.note).toBe("unsupported codec: mpeg4")
    // Nothing was remuxed or thumbnailed for a rejected asset.
    expect(res.processedBytes).toBeNull()
    expect(res.thumbnailBytes).toBeNull()
    expect(res.codec).toBeNull()
  })

  it("end-to-end: the mpeg4 row is persisted rejected and the ORIGINAL object is left untouched", async () => {
    const bytes = await fx.makeMpeg4Mp4()
    const { deps, storage, repo, reports } = makeEnv()
    const { id, uploadId, r2Key } = await seedVideo(storage, repo, bytes)

    const status = await runMediaChecksJob({ mediaId: id, uploadId, r2Key, kind: "video" }, deps)

    expect(status).toBe("rejected")
    expect(repo.get(id)!.status).toBe("rejected")
    expect(repo.get(id)!.thumbKey).toBeNull()
    expect(storage.get(`thumbs/${r2Key}.jpg`)).toBeNull()
    // The r2 object still holds the ORIGINAL bytes (no remux was written over them).
    expect(Buffer.from(storage.get(r2Key)!).equals(Buffer.from(bytes))).toBe(true)
    expect(reports.length).toBeGreaterThan(0)
  })

  it("ACCEPTS h264 through the same gate (the rejection above is the codec, not the fixture)", async () => {
    const { deps } = makeEnv()
    const res = await processMedia({ bytes: await fx.makeValidMp4(), kind: "video" }, deps)
    expect(res.status).toBe("ready")
    expect(res.codec).toBe("h264")
  })
})

describe("video duration bound (maxVideoDurationSec)", () => {
  it("REJECTS a clip longer than the cap, naming the bound", async () => {
    const bytes = await fx.makeH264Mp4OfSeconds(2)
    const { deps } = makeEnv({ limits: { ...limits, maxVideoDurationSec: 1 } })

    const res = await processMedia({ bytes, kind: "video" }, deps)

    expect(res.status).toBe("rejected")
    expect(res.note).toMatch(/^duration \d+(\.\d+)?s outside \(0, 1\]$/)
    expect(res.processedBytes).toBeNull()
  })

  it("ACCEPTS the SAME clip under the default 30s cap (proves the cap did the rejecting)", async () => {
    const bytes = await fx.makeH264Mp4OfSeconds(2)
    const { deps } = makeEnv()
    expect(limits.maxVideoDurationSec).toBe(30)

    const res = await processMedia({ bytes, kind: "video" }, deps)

    expect(res.status).toBe("ready")
    expect(res.note).toBeNull()
    expect(res.processedBytes).not.toBeNull()
  })

  it("end-to-end: an over-cap video is persisted rejected, nothing published", async () => {
    const bytes = await fx.makeH264Mp4OfSeconds(2)
    const { deps, storage, repo } = makeEnv({ limits: { ...limits, maxVideoDurationSec: 1 } })
    const { id, uploadId, r2Key } = await seedVideo(storage, repo, bytes)

    const status = await runMediaChecksJob({ mediaId: id, uploadId, r2Key, kind: "video" }, deps)

    expect(status).toBe("rejected")
    expect(repo.get(id)!.status).toBe("rejected")
    expect(repo.flags).toEqual([])
  })
})

describe("video frame-grab failure => HELD (never published unscored)", () => {
  it("holds the asset and raises an nsfw flag when NO frame can be decoded", async () => {
    stub.grabFrameError = new Error("ffmpeg: no decodable frame")
    const bytes = await fx.makeValidMp4()
    const { deps } = makeEnv()

    const res = await processMedia({ bytes, kind: "video" }, deps)

    expect(res.status).toBe("held")
    expect(res.flags).toEqual([{ reason: "nsfw" }])
    expect(res.note).toMatch(/no decodable frame extracted from video/)
    // The remux still succeeded (it does not need a decoded frame) - but with no thumbnail.
    expect(res.processedBytes).not.toBeNull()
    expect(res.processedContentType).toBe("video/mp4")
    expect(res.thumbnailBytes).toBeNull()
    expect(res.thumbnailContentType).toBeNull()
  })

  it("end-to-end: the row goes HELD with an abuse_flags row, and no thumb is written", async () => {
    stub.grabFrameError = new Error("ffmpeg: no decodable frame")
    const bytes = await fx.makeValidMp4()
    const { deps, storage, repo } = makeEnv()
    const { id, uploadId, r2Key } = await seedVideo(storage, repo, bytes)

    const status = await runMediaChecksJob({ mediaId: id, uploadId, r2Key, kind: "video" }, deps)

    expect(status).toBe("held")
    expect(repo.get(id)!.status).toBe("held")
    expect(repo.flags).toEqual([{ subjectId: id, reason: "nsfw", source: "worker" }])
    expect(repo.get(id)!.thumbKey).toBeNull()
    expect(storage.get(`thumbs/${r2Key}.jpg`)).toBeNull()
  })

  /**
   * The documented ModerationKind wart: there is no "video" member, so a held VIDEO enqueues as
   * kind:"image" and carries its real kind in the reason string. Pinned so the compensating detail cannot
   * be dropped silently, leaving the operator console actively misleading.
   */
  it("enqueues the held VIDEO for moderation as kind 'image' with the kind named in the reason", async () => {
    stub.grabFrameError = new Error("ffmpeg: no decodable frame")
    const bytes = await fx.makeValidMp4()
    const { deps, storage, repo } = makeEnv()
    const { id, uploadId, r2Key } = await seedVideo(storage, repo, bytes, { reportId: "report-vid" })

    const status = await runMediaChecksJob({ mediaId: id, uploadId, r2Key, kind: "video" }, deps)

    expect(status).toBe("held")
    expect(repo.moderationEnqueues).toHaveLength(1)
    expect(repo.moderationEnqueues[0]).toMatchObject({
      reportId: "report-vid",
      kind: "image",
      reason: "NSFW model over threshold (video)",
    })
  })

  it("with frame extraction WORKING the same video is ready + thumbnailed (control)", async () => {
    const bytes = await fx.makeValidMp4()
    const { deps, storage, repo } = makeEnv()
    const { id, uploadId, r2Key } = await seedVideo(storage, repo, bytes)

    const status = await runMediaChecksJob({ mediaId: id, uploadId, r2Key, kind: "video" }, deps)

    expect(status).toBe("ready")
    expect(repo.get(id)!.thumbKey).toBe(`thumbs/${r2Key}.jpg`)
    expect(storage.get(`thumbs/${r2Key}.jpg`)).not.toBeNull()
    expect(repo.flags).toEqual([])
  })
})
