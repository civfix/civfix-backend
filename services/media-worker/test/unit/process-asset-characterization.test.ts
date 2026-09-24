import { beforeEach, describe, expect, it, vi } from "vitest"
import { FakeAbuseChecks, FakeStorage } from "@civfix/shared/fakes"
import type { StorageHead } from "@civfix/shared/interfaces"
import type { MediaResultPatch } from "@civfix/api/media-repo"
import exifr from "exifr"
import { loadLimits, type WorkerLimits } from "../../src/config.js"
import { makeDownloader } from "../../src/download.js"
import { SandboxSpawnError } from "../../src/sandbox/exec.js"
import {
  runMediaChecksJob,
  MediaInfraError,
  type MediaChecksDeps,
  type MediaChecksPayload,
} from "../../src/jobs/media-checks.js"
import { InMemoryWorkerRepo } from "../helpers/in-memory-repo.js"
import * as fx from "../fixtures/make.js"

// Pins processAsset (reached through runMediaChecksJob) before it is split into helpers: every
// branch's status, persisted patch, storage puts/deletes, flags, moderation enqueues, log lines and
// reports must survive the refactor unchanged.

const ctl = vi.hoisted(() => ({
  grabFrameFailure: null as Error | null,
  imageLaneFailure: null as Error | null,
}))

vi.mock("../../src/sandbox/ffmpeg-remux.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/sandbox/ffmpeg-remux.js")>()
  return {
    ...actual,
    grabFrameJpeg: (...args: Parameters<typeof actual.grabFrameJpeg>) =>
      ctl.grabFrameFailure ? Promise.reject(ctl.grabFrameFailure) : actual.grabFrameJpeg(...args),
  }
})

vi.mock("../../src/sandbox/image-lane.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/sandbox/image-lane.js")>()
  return {
    ...actual,
    processImageLane: (...args: Parameters<typeof actual.processImageLane>) =>
      ctl.imageLaneFailure
        ? Promise.reject(ctl.imageLaneFailure)
        : actual.processImageLane(...args),
  }
})

const limits: WorkerLimits = loadLimits({})

class RecordingStorage extends FakeStorage {
  readonly puts: { key: string; contentType: string | undefined }[] = []
  readonly deletes: string[] = []
  headOverride: ((key: string) => Promise<StorageHead | null>) | null = null
  putFailure: Error | null = null

  override put(
    key: string,
    body: Uint8Array | Buffer,
    meta?: { contentType?: string; contentDisposition?: string },
  ): Promise<void> {
    this.puts.push({ key, contentType: meta?.contentType })
    if (this.putFailure) return Promise.reject(this.putFailure)
    return super.put(key, body, meta)
  }

  override delete(key: string): Promise<void> {
    this.deletes.push(key)
    return super.delete(key)
  }

  override head(key: string): Promise<StorageHead | null> {
    return this.headOverride ? this.headOverride(key) : super.head(key)
  }
}

interface Harness {
  deps: MediaChecksDeps
  storage: RecordingStorage
  repo: InMemoryWorkerRepo
  abuse: FakeAbuseChecks
  patches: MediaResultPatch[]
  logs: { line: string; extra: Record<string, unknown> }[]
  reports: { message: string; context: Record<string, unknown> }[]
}

function makeHarness(over?: Partial<MediaChecksDeps>): Harness {
  const storage = new RecordingStorage()
  const repo = new InMemoryWorkerRepo()
  const abuse = new FakeAbuseChecks()
  const patches: MediaResultPatch[] = []
  const logs: Harness["logs"] = []
  const reports: Harness["reports"] = []
  const realApply = repo.applyResult.bind(repo)
  repo.applyResult = (id, patch) => {
    patches.push({ ...patch })
    return realApply(id, patch)
  }
  const deps: MediaChecksDeps = {
    repo,
    storage,
    abuseChecks: abuse,
    limits,
    download: makeDownloader(storage),
    log: (line, extra) => logs.push({ line, extra: extra ?? {} }),
    report: (err, context) =>
      reports.push({
        message: err instanceof Error ? err.message : String(err),
        context: context ?? {},
      }),
    ...over,
  }
  return { deps, storage, repo, abuse, patches, logs, reports }
}

const ID = "media-char-1"
const UPLOAD_ID = "up-char-1"
const R2_KEY = `uploads/2026/06/${ID}`
const SERVED = `processed/${R2_KEY}`
const THUMB = `thumbs/${R2_KEY}.jpg`

async function seed(
  h: Harness,
  kind: "image" | "video",
  bytes: Uint8Array,
  extra?: { reportId?: string; status?: "validating" | "ready" | "held" | "rejected" },
): Promise<MediaChecksPayload> {
  h.repo.seed({ id: ID, uploadId: UPLOAD_ID, kind, r2Key: R2_KEY, ...extra })
  await FakeStorage.prototype.put.call(h.storage, R2_KEY, Buffer.from(bytes), {
    contentType: kind === "video" ? "video/mp4" : "image/jpeg",
  })
  return { mediaId: ID, uploadId: UPLOAD_ID, r2Key: R2_KEY, kind }
}

async function storedKeys(h: Harness): Promise<string[]> {
  return (await h.storage.list("")).keys
}

beforeEach(() => {
  ctl.grabFrameFailure = null
  ctl.imageLaneFailure = null
})

const REJECT_CLEANUP_DELETES = [R2_KEY, SERVED, THUMB]
const HEX16 = /^[0-9a-f]{16}$/

function rejectionReport(kind: "image" | "video", note: string) {
  return {
    message: note,
    context: { job: "media.checks", mediaId: ID, kind, note },
  }
}

function rejectionLog(kind: "image" | "video", note: string) {
  return { line: "media.checks: rejected", extra: { mediaId: ID, kind, note } }
}

function expectRejectedAfterProcessing(h: Harness, kind: "image" | "video", note: string) {
  expect(h.repo.get(ID)!.status).toBe("rejected")
  expect(h.patches).toEqual([
    { status: "rejected", codec: null, width: null, height: null, phash: null },
  ])
  expect(h.storage.puts).toEqual([])
  expect(h.storage.deletes).toEqual(REJECT_CLEANUP_DELETES)
  expect(h.repo.flags).toEqual([])
  expect(h.repo.moderationEnqueues).toEqual([])
  expect(h.logs).toEqual([rejectionLog(kind, note)])
  expect(h.reports).toEqual([rejectionReport(kind, note)])
}

function expectRejectedBeforeProcessing(h: Harness, note: string) {
  expect(h.repo.get(ID)!.status).toBe("rejected")
  expect(h.patches).toEqual([{ status: "rejected" }])
  expect(h.storage.puts).toEqual([])
  expect(h.storage.deletes).toEqual(REJECT_CLEANUP_DELETES)
  expect(h.repo.flags).toEqual([])
  expect(h.repo.moderationEnqueues).toEqual([])
  expect(h.logs).toEqual([rejectionLog("image", note)])
  expect(h.reports).toEqual([rejectionReport("image", note)])
}

function expectUntouchedAfterInfraFailure(h: Harness) {
  expect(h.repo.get(ID)!.status).toBe("validating")
  expect(h.patches).toEqual([])
  expect(h.repo.flags).toEqual([])
  expect(h.repo.moderationEnqueues).toEqual([])
  expect(h.storage.deletes).toEqual([])
}

describe("processAsset: already-terminal asset", () => {
  it("returns the stored status without downloading, persisting or touching storage", async () => {
    const h = makeHarness()
    let downloads = 0
    h.deps.download = () => {
      downloads++
      return Promise.reject(new Error("must not download"))
    }
    const payload = await seed(h, "image", await fx.makeValidPng(), { status: "held" })

    await expect(runMediaChecksJob(payload, h.deps)).resolves.toBe("held")

    expect(downloads).toBe(0)
    expect(h.patches).toEqual([])
    expect(h.storage.puts).toEqual([])
    expect(h.storage.deletes).toEqual([])
    expect(await storedKeys(h)).toEqual([R2_KEY])
    expect(h.logs).toEqual([
      {
        line: "media.checks: asset already terminal, skipping",
        extra: { mediaId: ID, uploadId: UPLOAD_ID, status: "held" },
      },
    ])
    expect(h.reports).toEqual([])
  })
})

describe("processAsset: valid JPEG carrying EXIF GPS", () => {
  it("publishes ready: served + thumb written, upload deleted, exact patch shape, GPS never persisted", async () => {
    const h = makeHarness()
    const input = await fx.makeValidJpegWithGps()
    expect((await exifr.gps(input))?.latitude).toBeCloseTo(37.7672, 3)
    const payload = await seed(h, "image", input)

    await expect(runMediaChecksJob(payload, h.deps)).resolves.toBe("ready")

    const served = h.storage.get(SERVED)!
    const thumb = h.storage.get(THUMB)!
    expect(h.patches).toHaveLength(1)
    const patch = h.patches[0]!
    expect(Object.keys(patch)).toEqual([
      "status",
      "codec",
      "width",
      "height",
      "phash",
      "byteSize",
      "servedKey",
      "thumbKey",
    ])
    expect(patch).toMatchObject({
      status: "ready",
      codec: null,
      width: 64,
      height: 48,
      byteSize: served.byteLength,
      servedKey: SERVED,
      thumbKey: THUMB,
    })
    expect(patch.phash).toMatch(HEX16)

    expect(h.storage.puts).toEqual([
      { key: SERVED, contentType: "image/jpeg" },
      { key: THUMB, contentType: "image/jpeg" },
    ])
    expect(h.storage.deletes).toEqual([R2_KEY])
    expect(await storedKeys(h)).toEqual([SERVED, THUMB])
    expect(h.repo.flags).toEqual([])
    expect(h.repo.moderationEnqueues).toEqual([])
    expect(h.reports).toEqual([])
    expect(h.logs).toEqual([
      {
        line: "media.checks: ready",
        extra: {
          mediaId: ID,
          kind: "image",
          width: 64,
          height: 48,
          codec: null,
          exifGpsPresent: true,
        },
      },
    ])

    expect((await exifr.gps(Buffer.from(served)))?.latitude ?? null).toBeNull()
    expect((await exifr.gps(Buffer.from(thumb)))?.latitude ?? null).toBeNull()
    const persisted = JSON.stringify({ row: h.repo.get(ID), patches: h.patches, logs: h.logs })
    expect(persisted).not.toMatch(/latitude|longitude|37\.76|122\.4/)
  })

  it("refreshes avatar URLs with the public served URL when a public media base is configured", async () => {
    const h = makeHarness({ publicMediaBase: "https://media.example.test/" })
    const refreshes: [string, string][] = []
    h.repo.refreshAvatarUrls = (mediaId, url) => {
      refreshes.push([mediaId, url])
      return Promise.resolve(1)
    }
    const payload = await seed(h, "image", await fx.makeValidJpegWithGps())

    await expect(runMediaChecksJob(payload, h.deps)).resolves.toBe("ready")

    expect(refreshes).toEqual([[ID, `https://media.example.test/${SERVED}`]])
  })
})

describe("processAsset: NSFW hold", () => {
  it("held image: published bytes, nsfw flag, and one moderation item for the report", async () => {
    const h = makeHarness()
    const payload = await seed(h, "image", await fx.makeNsfwJpeg(), { reportId: "report-n" })

    await expect(runMediaChecksJob(payload, h.deps)).resolves.toBe("held")

    expect(h.patches).toEqual([
      {
        status: "held",
        codec: null,
        width: 50,
        height: 50,
        phash: expect.stringMatching(HEX16) as unknown,
        byteSize: h.storage.get(SERVED)!.byteLength,
        servedKey: SERVED,
        thumbKey: THUMB,
      },
    ])
    expect(h.storage.deletes).toEqual([R2_KEY])
    expect(await storedKeys(h)).toEqual([SERVED, THUMB])
    expect(h.repo.flags).toEqual([{ subjectId: ID, reason: "nsfw", source: "worker" }])
    expect(h.repo.moderationEnqueues).toEqual([
      {
        reportId: "report-n",
        reason: "NSFW model over threshold (image)",
        kind: "image",
        note: "nsfw score 1.000",
      },
    ])
    expect(h.logs).toEqual([
      {
        line: "media.checks: held",
        extra: { mediaId: ID, note: "nsfw score 1.000", flags: ["nsfw"] },
      },
    ])
    expect(h.reports).toEqual([])
  })
})

describe("processAsset: rejected by the pipeline (never throws on bad bytes)", () => {
  it("pixel bomb PNG", async () => {
    const h = makeHarness()
    const payload = await seed(h, "image", fx.makePixelBombPng())

    await expect(runMediaChecksJob(payload, h.deps)).resolves.toBe("rejected")

    expectRejectedAfterProcessing(h, "image", "image decode/guard failed: metadata failed")
    expect(await storedKeys(h)).toEqual([])
  })

  it("non-allowlisted image container (SVG)", async () => {
    const h = makeHarness()
    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>',
    )
    const payload = await seed(h, "image", svg)

    await expect(runMediaChecksJob(payload, h.deps)).resolves.toBe("rejected")

    expectRejectedAfterProcessing(
      h,
      "image",
      "image decode/guard failed: unsupported image container (magic bytes not JPEG/PNG/WebP)",
    )
  })

  it("non-allowlisted video container (HLS playlist)", async () => {
    const h = makeHarness()
    const payload = await seed(h, "video", fx.makeHlsPlaylist("http://127.0.0.1:9/seg.ts"))

    await expect(runMediaChecksJob(payload, h.deps)).resolves.toBe("rejected")

    expectRejectedAfterProcessing(
      h,
      "video",
      'ffprobe failed: sandbox tool "ffprobe" failed (exit 1)',
    )
  })

  it("video over the duration cap", async () => {
    const h = makeHarness({ limits: { ...limits, maxVideoDurationSec: 2 } })
    const payload = await seed(h, "video", await fx.makeH264Mp4OfSeconds(3))

    await expect(runMediaChecksJob(payload, h.deps)).resolves.toBe("rejected")

    expectRejectedAfterProcessing(h, "video", "duration 3s outside (0, 2]")
  })
})

describe("processAsset: video", () => {
  it("valid h264 MP4 publishes ready with a remux and a frame thumbnail", async () => {
    const h = makeHarness()
    const payload = await seed(h, "video", await fx.makeValidMp4())

    await expect(runMediaChecksJob(payload, h.deps)).resolves.toBe("ready")

    expect(h.patches).toEqual([
      {
        status: "ready",
        codec: "h264",
        width: 320,
        height: 240,
        phash: null,
        byteSize: h.storage.get(SERVED)!.byteLength,
        servedKey: SERVED,
        thumbKey: THUMB,
      },
    ])
    expect(h.storage.puts).toEqual([
      { key: SERVED, contentType: "video/mp4" },
      { key: THUMB, contentType: "image/jpeg" },
    ])
    expect(h.storage.deletes).toEqual([R2_KEY])
    expect(h.logs).toEqual([
      {
        line: "media.checks: ready",
        extra: {
          mediaId: ID,
          kind: "video",
          width: 320,
          height: 240,
          codec: "h264",
          exifGpsPresent: false,
        },
      },
    ])
  })

  it("frame-grab failure holds the video: remux published, no thumbnail, nsfw flag, moderation item", async () => {
    ctl.grabFrameFailure = new Error("frame grab exploded")
    const h = makeHarness()
    const payload = await seed(h, "video", await fx.makeValidMp4(), { reportId: "report-v" })

    await expect(runMediaChecksJob(payload, h.deps)).resolves.toBe("held")

    const note = "nsfw scoring failed (held): no decodable frame extracted from video"
    expect(h.patches).toEqual([
      {
        status: "held",
        codec: "h264",
        width: 320,
        height: 240,
        phash: null,
        byteSize: h.storage.get(SERVED)!.byteLength,
        servedKey: SERVED,
      },
    ])
    expect(h.storage.puts).toEqual([{ key: SERVED, contentType: "video/mp4" }])
    expect(h.storage.deletes).toEqual([R2_KEY])
    expect(await storedKeys(h)).toEqual([SERVED])
    expect(h.repo.flags).toEqual([{ subjectId: ID, reason: "nsfw", source: "worker" }])
    expect(h.repo.moderationEnqueues).toEqual([
      { reportId: "report-v", reason: "NSFW model over threshold (video)", kind: "image", note },
    ])
    expect(h.logs).toEqual([
      { line: "media.checks: held", extra: { mediaId: ID, note, flags: ["nsfw"] } },
    ])
    expect(h.reports).toEqual([])
  })
})

describe("processAsset: infra failures throw MediaInfraError and leave the asset validating", () => {
  it("storage unavailable at download", async () => {
    const h = makeHarness()
    h.repo.seed({ id: ID, uploadId: UPLOAD_ID, kind: "image", r2Key: R2_KEY })
    const payload: MediaChecksPayload = {
      mediaId: ID,
      uploadId: UPLOAD_ID,
      r2Key: R2_KEY,
      kind: "image",
    }

    const err: unknown = await runMediaChecksJob(payload, h.deps).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(MediaInfraError)
    expect((err as Error).message).toBe(
      `media.checks infra failure (download, retryable): storage unavailable for ${R2_KEY}`,
    )
    expectUntouchedAfterInfraFailure(h)
    expect(h.storage.puts).toEqual([])
    expect(h.logs).toEqual([
      {
        line: "media.checks: download infra failure, will retry",
        extra: {
          mediaId: ID,
          r2Key: R2_KEY,
          err: `StorageUnavailableError: storage unavailable for ${R2_KEY}`,
        },
      },
    ])
    expect(h.reports).toEqual([
      {
        message: `storage unavailable for ${R2_KEY}`,
        context: { job: "media.checks", phase: "download-infra", mediaId: ID },
      },
    ])
  })

  it("pre-publish head failure", async () => {
    const h = makeHarness()
    const payload = await seed(h, "image", await fx.makeValidPng())
    h.deps.download = (key) => Promise.resolve({ bytes: h.storage.get(key)!, etag: null })
    h.storage.headOverride = () => Promise.reject(new Error("head 503"))

    const err: unknown = await runMediaChecksJob(payload, h.deps).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(MediaInfraError)
    expect((err as Error).message).toBe(
      "media.checks infra failure (publish-precheck, retryable): head 503",
    )
    expectUntouchedAfterInfraFailure(h)
    expect(h.storage.puts).toEqual([])
    expect(h.logs).toEqual([
      {
        line: "media.checks: pre-publish head failed, will retry",
        extra: { mediaId: ID, err: "Error: head 503" },
      },
    ])
    expect(h.reports).toEqual([
      {
        message: "head 503",
        context: { job: "media.checks", phase: "publish-precheck", mediaId: ID },
      },
    ])
  })

  it("storage put failure while publishing (no flags written, no patch applied)", async () => {
    const h = makeHarness()
    const payload = await seed(h, "image", await fx.makeValidPng())
    h.storage.putFailure = new Error("put 503")

    const err: unknown = await runMediaChecksJob(payload, h.deps).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(MediaInfraError)
    expect((err as Error).message).toBe("media.checks infra failure (persist, retryable): put 503")
    expectUntouchedAfterInfraFailure(h)
    expect(h.storage.puts).toEqual([
      { key: SERVED, contentType: "image/png" },
      { key: THUMB, contentType: "image/jpeg" },
    ])
    expect(await storedKeys(h)).toEqual([R2_KEY])
    expect(h.logs).toEqual([
      {
        line: "media.checks: persist infra failure, will retry",
        extra: { mediaId: ID, err: "Error: put 503" },
      },
    ])
    expect(h.reports).toEqual([
      { message: "put 503", context: { job: "media.checks", phase: "persist", mediaId: ID } },
    ])
  })

  it("image-lane sandbox spawn failure becomes MediaInfraError sandbox-spawn", async () => {
    ctl.imageLaneFailure = new SandboxSpawnError("image-lane", new Error("ENOENT"))
    const h = makeHarness()
    const payload = await seed(h, "image", await fx.makeValidPng())

    const err: unknown = await runMediaChecksJob(payload, h.deps).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(MediaInfraError)
    expect((err as Error).message).toBe(
      'media.checks infra failure (sandbox-spawn, retryable): sandbox tool "image-lane" could not be started: ENOENT',
    )
    expectUntouchedAfterInfraFailure(h)
    expect(h.storage.puts).toEqual([])
    expect(await storedKeys(h)).toEqual([R2_KEY])
    expect(h.logs).toEqual([
      {
        line: "media.checks: a decoder could not be started, will retry",
        extra: {
          mediaId: ID,
          err: 'SandboxSpawnError: sandbox tool "image-lane" could not be started: ENOENT',
        },
      },
    ])
    expect(h.reports).toEqual([
      {
        message: 'sandbox tool "image-lane" could not be started: ENOENT',
        context: { job: "media.checks", phase: "sandbox-spawn", mediaId: ID },
      },
    ])
  })

  it("video frame-grab sandbox spawn failure also becomes MediaInfraError sandbox-spawn, not a hold", async () => {
    ctl.grabFrameFailure = new SandboxSpawnError("ffmpeg", new Error("EAGAIN"))
    const h = makeHarness()
    const payload = await seed(h, "video", await fx.makeValidMp4())

    const err: unknown = await runMediaChecksJob(payload, h.deps).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(MediaInfraError)
    expect((err as Error).message).toBe(
      'media.checks infra failure (sandbox-spawn, retryable): sandbox tool "ffmpeg" could not be started: EAGAIN',
    )
    expectUntouchedAfterInfraFailure(h)
    expect(h.storage.puts).toEqual([])
    expect(h.reports).toEqual([
      {
        message: 'sandbox tool "ffmpeg" could not be started: EAGAIN',
        context: { job: "media.checks", phase: "sandbox-spawn", mediaId: ID },
      },
    ])
  })

  it("a persist failure while recording a rejection throws MediaInfraError reject", async () => {
    const h = makeHarness()
    const payload = await seed(h, "image", await fx.makeValidPng())
    h.deps.download = (key) => Promise.resolve({ bytes: h.storage.get(key)!, etag: "etag-b" })
    h.repo.failApplyResult = new Error("db down")

    const err: unknown = await runMediaChecksJob(
      { ...payload, uploadEtag: "etag-a" },
      h.deps,
    ).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(MediaInfraError)
    expect((err as Error).message).toBe("media.checks infra failure (reject, retryable): db down")
    expect(h.repo.get(ID)!.status).toBe("validating")
    expect(h.storage.deletes).toEqual([])
    expect(h.logs).toEqual([
      {
        line: "media.checks: failed to persist rejection, will retry",
        extra: {
          mediaId: ID,
          note: "upload object changed between finalize and processing",
          err: "Error: db down",
        },
      },
    ])
    expect(h.reports).toEqual([
      { message: "db down", context: { job: "media.checks", phase: "reject", mediaId: ID } },
    ])
  })
})

describe("processAsset: upload identity checks", () => {
  it("ETag mismatch between finalize and download rejects without processing", async () => {
    const h = makeHarness()
    let scored = 0
    h.abuse.nsfwScore = () => {
      scored++
      return Promise.resolve(0)
    }
    const payload = await seed(h, "image", await fx.makeValidPng())
    h.deps.download = (key) => Promise.resolve({ bytes: h.storage.get(key)!, etag: "etag-b" })

    await expect(runMediaChecksJob({ ...payload, uploadEtag: "etag-a" }, h.deps)).resolves.toBe(
      "rejected",
    )

    expect(scored).toBe(0)
    expectRejectedBeforeProcessing(h, "upload object changed between finalize and processing")
    expect(await storedKeys(h)).toEqual([])
  })

  it("a matching ETag, or a download with no ETag, proceeds to publish", async () => {
    for (const downloadEtag of ["etag-a", null]) {
      const h = makeHarness()
      const payload = await seed(h, "image", await fx.makeValidPng())
      h.deps.download = (key) => Promise.resolve({ bytes: h.storage.get(key)!, etag: downloadEtag })

      await expect(runMediaChecksJob({ ...payload, uploadEtag: "etag-a" }, h.deps)).resolves.toBe(
        "ready",
      )
    }
  })

  it("an upload overwritten during processing (head ETag drift) rejects before publishing", async () => {
    const h = makeHarness()
    const payload = await seed(h, "image", await fx.makeValidPng())
    h.deps.download = (key) => Promise.resolve({ bytes: h.storage.get(key)!, etag: "etag-1" })
    h.storage.headOverride = () =>
      Promise.resolve({ size: 1, contentType: "image/png", etag: "etag-2" } as StorageHead)

    await expect(runMediaChecksJob(payload, h.deps)).resolves.toBe("rejected")

    expectRejectedBeforeProcessing(h, "upload object was overwritten during processing")
  })

  it("an upload that disappeared before publish rejects before publishing", async () => {
    const h = makeHarness()
    const payload = await seed(h, "image", await fx.makeValidPng())
    h.deps.download = (key) => Promise.resolve({ bytes: h.storage.get(key)!, etag: null })
    h.storage.headOverride = () => Promise.resolve(null)

    await expect(runMediaChecksJob(payload, h.deps)).resolves.toBe("rejected")

    expectRejectedBeforeProcessing(h, "upload object disappeared before publish")
  })

  it("a download over the byte cap rejects without processing", async () => {
    const h = makeHarness({ limits: { ...limits, maxDownloadBytes: 10 } })
    const payload = await seed(h, "image", await fx.makeValidPng())

    await expect(runMediaChecksJob(payload, h.deps)).resolves.toBe("rejected")

    expectRejectedBeforeProcessing(h, "download too large: download exceeds cap of 10 bytes")
  })
})
