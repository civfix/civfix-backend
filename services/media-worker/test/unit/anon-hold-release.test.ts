import { describe, it, expect } from "vitest"
import { FakeStorage, FakeAbuseChecks } from "@civfix/shared/fakes"
import type { LatLng } from "@civfix/shared"
import { makeWorker } from "../../src/worker.js"
import { makeJobs } from "../../src/worker-jobs.js"
import { loadLimits } from "../../src/config.js"
import { makeDownloader } from "../../src/download.js"
import type { WorkerSeams } from "../../src/seams.js"
import { runHoldReleaseSweep } from "../../src/jobs/hold-release-sweep.js"
import { MEDIA_CHECKS_JOB } from "@civfix/api/queue-names"
import type {
  AnonHoldReleaseRepository,
  HeldReportView,
  ReleaseMediaView,
} from "@civfix/api/anon-hold-release"
import { InMemoryMediaWorkerRepository } from "../helpers/in-memory-media-worker-repository.js"
import * as fx from "../fixtures/make.js"

class MemHoldRepo implements AnonHoldReleaseRepository {
  report: HeldReportView
  openFlags = 0
  published = false

  constructor(
    report: HeldReportView,
    private readonly mediaRepo: InMemoryMediaWorkerRepository,
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
  findHeldAnonReportIds(limit: number): Promise<string[]> {
    const held =
      this.report.reporterUserId === null && this.report.status === "held" ? [this.report.id] : []
    return Promise.resolve(held.slice(0, limit))
  }
}

function makeSeams(opts: {
  repo: InMemoryMediaWorkerRepository
  anonHoldRepo: AnonHoldReleaseRepository
  abuse: FakeAbuseChecks
  storage: FakeStorage
}): WorkerSeams {
  const limits = loadLimits({})
  return {
    storage: opts.storage,
    publicMediaBase: undefined,
    inboundStorage: opts.storage,
    abuseChecks: opts.abuse,
    limits,
    download: makeDownloader(opts.storage),
    dbHandle: undefined,
    repo: opts.repo,
    anonHoldRepo: opts.anonHoldRepo,
    findPhashDuplicate: undefined,
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

async function seedMedia(
  storage: FakeStorage,
  repo: InMemoryMediaWorkerRepository,
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
    const repo = new InMemoryMediaWorkerRepository()
    const abuse = new FakeAbuseChecks()
    const reportId = "anon-report-ready"
    const holdRepo = new MemHoldRepo(heldReport(reportId), repo)

    const handle = makeJobs()
    const seams = makeSeams({ repo, anonHoldRepo: holdRepo, abuse, storage })
    const worker = await makeWorker(handle, seams)
    await worker.start()

    const valid = await fx.makeValidPng()
    const { mediaId, uploadId, r2Key } = await seedMedia(storage, repo, reportId, valid)

    await handle.jobs.enqueue(MEDIA_CHECKS_JOB, { mediaId, uploadId, r2Key, kind: "image" })

    expect(repo.get(mediaId)!.status).toBe("ready")
    expect(holdRepo.published).toBe(true)
    expect(holdRepo.report.status).toBe("published")

    await worker.stop()
  })

  it("keeps the report held when the media is NSFW (held), even though the hook fires", async () => {
    const storage = new FakeStorage()
    const repo = new InMemoryMediaWorkerRepository()
    const abuse = new FakeAbuseChecks()
    const reportId = "anon-report-nsfw"
    const holdRepo = new MemHoldRepo(heldReport(reportId), repo)

    const handle = makeJobs()
    const seams = makeSeams({ repo, anonHoldRepo: holdRepo, abuse, storage })
    const worker = await makeWorker(handle, seams)
    await worker.start()

    const nsfw = await fx.makeNsfwJpeg()
    const { mediaId, uploadId, r2Key } = await seedMedia(storage, repo, reportId, nsfw)
    await handle.jobs.enqueue(MEDIA_CHECKS_JOB, { mediaId, uploadId, r2Key, kind: "image" })

    expect(repo.get(mediaId)!.status).toBe("held")
    expect(holdRepo.published).toBe(false)
    expect(holdRepo.report.status).toBe("held")

    await worker.stop()
  })
})

describe("hold-release self-healing sweep (P2-8)", () => {
  it("publishes a held anon report whose media are ready even if NO inline enqueue ever fired", async () => {
    const repo = new InMemoryMediaWorkerRepository()
    const reportId = "anon-report-stuck"
    repo.seed({ id: "m1", uploadId: "u1", kind: "image", r2Key: "k1", reportId, status: "ready" })
    const holdRepo = new MemHoldRepo(heldReport(reportId), repo)
    const abuse = new FakeAbuseChecks()

    const result = await runHoldReleaseSweep({
      repo: holdRepo,
      abuseChecks: abuse,
      batchSize: 50,
      log: () => {},
      report: () => {},
    })

    expect(result.scanned).toBe(1)
    expect(result.published).toBe(1)
    expect(holdRepo.published).toBe(true)
    expect(holdRepo.report.status).toBe("published")

    const again = await runHoldReleaseSweep({
      repo: holdRepo,
      abuseChecks: abuse,
      batchSize: 50,
      log: () => {},
      report: () => {},
    })
    expect(again.published).toBe(0)
  })

  it("leaves a held report held when its media are NOT yet ready (re-checked next run)", async () => {
    const repo = new InMemoryMediaWorkerRepository()
    const reportId = "anon-report-pending"
    repo.seed({
      id: "m1",
      uploadId: "u1",
      kind: "image",
      r2Key: "k1",
      reportId,
      status: "validating",
    })
    const holdRepo = new MemHoldRepo(heldReport(reportId), repo)

    const result = await runHoldReleaseSweep({
      repo: holdRepo,
      abuseChecks: new FakeAbuseChecks(),
      batchSize: 50,
      log: () => {},
      report: () => {},
    })
    expect(result.scanned).toBe(1)
    expect(result.published).toBe(0)
    expect(holdRepo.report.status).toBe("held")
  })
})
