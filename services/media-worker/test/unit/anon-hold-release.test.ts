/**
 * Worker wiring for the hold-then-publish release (offline, no DB, no Docker).
 *
 * Builds the worker over FakeJobs + custom seams (FakeStorage + an in-memory media repo + an in-memory
 * AnonHoldReleaseRepo + FakeAbuseChecks). FakeJobs runs a handler synchronously on enqueue, so a single
 * media.checks enqueue drives the WHOLE chain end to end:
 *   media.checks (processes bytes -> media ready) -> post-success hook enqueues anon.hold.release ->
 *   anon.hold.release handler runs releaseAnonHoldIfReady -> the held anon report is published.
 *
 * The "stays held" case feeds an NSFW image: media.checks holds the media, the hook still fires, and the
 * release gate keeps the report held.
 */

import { describe, it, expect } from "vitest"
import { FakeStorage, FakeAbuseChecks } from "@civfix/shared/fakes"
import type { LatLng } from "@civfix/shared"
import { buildWorker } from "../../src/worker.js"
import { buildJobs } from "../../src/jobs.js"
import { loadLimits } from "../../src/config.js"
import { makeDownloader } from "../../src/download.js"
import type { WorkerSeams } from "../../src/seams.js"
import { MEDIA_CHECKS_JOB } from "@civfix/api/media-repo"
import type {
  AnonHoldReleaseRepo,
  HeldReportView,
  ReleaseMediaView,
} from "@civfix/api/anon-hold-release"
import { InMemoryWorkerRepo } from "../helpers/in-memory-repo.js"
import * as fx from "../fixtures/make.js"

/**
 * A tiny in-memory AnonHoldReleaseRepo. Its media view is DERIVED from the shared worker repo (by
 * reportId) so it always reflects the status the media.checks job just wrote - exactly like production,
 * where both read the same media_assets rows.
 */
class MemHoldRepo implements AnonHoldReleaseRepo {
  report: HeldReportView
  openFlags = 0
  published = false

  constructor(
    report: HeldReportView,
    private readonly mediaRepo: InMemoryWorkerRepo,
  ) {
    this.report = report
  }

  findReport(reportId: string): Promise<HeldReportView | null> {
    return Promise.resolve(reportId === this.report.id ? { ...this.report } : null)
  }
  findMedia(reportId: string): Promise<ReleaseMediaView[]> {
    const out: ReleaseMediaView[] = []
    for (const row of this.mediaRepo.byId.values()) {
      if (row.reportId === reportId) out.push({ id: row.id, status: row.status })
    }
    return Promise.resolve(out)
  }
  countOpenAbuseFlags(_reportId: string, _mediaIds: string[]): Promise<number> {
    return Promise.resolve(this.openFlags)
  }
  publishHeldReport(reportId: string, _publishedAt: Date): Promise<boolean> {
    if (reportId !== this.report.id || this.report.status !== "held") return Promise.resolve(false)
    this.report.status = "published"
    this.published = true
    return Promise.resolve(true)
  }
}

/** Build offline worker seams with a custom media repo + hold repo + abuse checks. */
function makeSeams(opts: {
  repo: InMemoryWorkerRepo
  anonHoldRepo: AnonHoldReleaseRepo
  abuse: FakeAbuseChecks
  storage: FakeStorage
}): WorkerSeams {
  const limits = loadLimits({})
  return {
    storage: opts.storage,
    abuseChecks: opts.abuse,
    limits,
    download: makeDownloader(opts.storage),
    dbHandle: undefined,
    repo: opts.repo,
    anonHoldRepo: opts.anonHoldRepo,
    report: () => {},
    close: () => Promise.resolve(),
  }
}

const REPORT_POINT: LatLng = { lat: 34.1, lng: -118.35 }

function heldReport(id: string): HeldReportView {
  return {
    id,
    reporterUserId: null,
    anonSessionId: "anontok-1",
    status: "held",
    visibility: "public",
    lat: REPORT_POINT.lat,
    lng: REPORT_POINT.lng,
    deletedAt: null,
  }
}

/** Seed a media row + stage its bytes, attached to an anon report. */
async function seedMedia(
  storage: FakeStorage,
  repo: InMemoryWorkerRepo,
  reportId: string,
  bytes: Buffer,
): Promise<{ mediaId: string; uploadId: string; r2Key: string }> {
  const mediaId = `media-${Math.random().toString(36).slice(2, 8)}`
  const uploadId = `up-${Math.random().toString(36).slice(2, 8)}`
  const r2Key = `uploads/2026/06/${mediaId}`
  repo.seed({ id: mediaId, uploadId, kind: "image", r2Key, reportId, status: "validating" })
  await storage.put(r2Key, bytes, { contentType: "image/jpeg" })
  return { mediaId, uploadId, r2Key }
}

describe("media-worker hold-release wiring", () => {
  it("publishes a held anon report once its media goes ready and is clean", async () => {
    const storage = new FakeStorage()
    const repo = new InMemoryWorkerRepo()
    const abuse = new FakeAbuseChecks()
    const reportId = "anon-report-ready"
    const holdRepo = new MemHoldRepo(heldReport(reportId), repo)

    const handle = buildJobs() // FakeJobs (runs handlers synchronously on enqueue)
    const seams = makeSeams({ repo, anonHoldRepo: holdRepo, abuse, storage })
    const worker = await buildWorker(handle, seams)
    await worker.start()

    const valid = await fx.makeValidPng()
    const { mediaId, uploadId, r2Key } = await seedMedia(storage, repo, reportId, valid)

    // Enqueue media.checks: FakeJobs runs it now; its post-success hook enqueues anon.hold.release,
    // which FakeJobs also runs now, publishing the report.
    await handle.jobs.enqueue(MEDIA_CHECKS_JOB, { mediaId, uploadId, r2Key, kind: "image" })

    expect(repo.get(mediaId)!.status).toBe("ready")
    expect(holdRepo.published).toBe(true)
    expect(holdRepo.report.status).toBe("published")

    await worker.stop()
  })

  it("keeps the report held when the media is NSFW (held), even though the hook fires", async () => {
    const storage = new FakeStorage()
    const repo = new InMemoryWorkerRepo()
    const abuse = new FakeAbuseChecks()
    const reportId = "anon-report-nsfw"
    const holdRepo = new MemHoldRepo(heldReport(reportId), repo)

    const handle = buildJobs()
    const seams = makeSeams({ repo, anonHoldRepo: holdRepo, abuse, storage })
    const worker = await buildWorker(handle, seams)
    await worker.start()

    // An NSFW image: media.checks marks the media held; the hook fires and the release gate (reading the
    // now-held media from the shared repo) keeps the report held.
    const nsfw = await fx.makeNsfwJpeg()
    const { mediaId, uploadId, r2Key } = await seedMedia(storage, repo, reportId, nsfw)
    await handle.jobs.enqueue(MEDIA_CHECKS_JOB, { mediaId, uploadId, r2Key, kind: "image" })

    expect(repo.get(mediaId)!.status).toBe("held")
    expect(holdRepo.published).toBe(false)
    expect(holdRepo.report.status).toBe("held")

    await worker.stop()
  })
})
