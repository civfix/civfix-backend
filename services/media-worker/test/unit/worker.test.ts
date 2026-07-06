
import { describe, it, expect } from "vitest"
import {
  buildWorker,
  ORPHAN_SWEEP_JOB,
  CHAT_PARTITION_JOB,
  ANON_HOLD_RELEASE_JOB,
} from "../../src/worker.js"
import { buildJobs } from "../../src/jobs.js"
import { buildSeams, type WorkerSeams } from "../../src/seams.js"
import { loadLimits } from "../../src/config.js"
import { makeDownloader } from "../../src/download.js"
import { MEDIA_CHECKS_JOB } from "@civfix/api/media-repo"
import type { AnonHoldReleaseRepo, HeldReportView } from "@civfix/api/anon-hold-release"
import { FakeJobs, FakeStorage, FakeAbuseChecks } from "@civfix/shared/fakes"
import { InMemoryWorkerRepo } from "../helpers/in-memory-repo.js"
import * as fx from "../fixtures/make.js"

describe("media-worker wiring", () => {
  it("builds a worker over the fake Jobs seam", async () => {
    const handle = buildJobs()
    expect(handle.jobs).toBeInstanceOf(FakeJobs)
    const seams = await buildSeams()
    const worker = await buildWorker(handle, seams)
    expect(worker.jobs).toBe(handle.jobs)
    await seams.close()
  })

  it("start() registers the media.checks handler + both cron schedules, stop() resolves", async () => {
    const handle = buildJobs()
    const fake = handle.jobs as unknown as FakeJobs
    const seams = await buildSeams()
    const worker = await buildWorker(handle, seams)

    await expect(worker.start()).resolves.toBeUndefined()

    const beforeEnqueue = fake.enqueued.length
    await fake.enqueue(MEDIA_CHECKS_JOB, {
      mediaId: "x",
      uploadId: "y",
      r2Key: "uploads/z",
      kind: "image",
    })
    expect(fake.enqueued.length).toBe(beforeEnqueue + 1)

    const scheduledNames = fake.scheduled.map((s) => s.name)
    expect(scheduledNames).toContain(ORPHAN_SWEEP_JOB)
    expect(scheduledNames).toContain(CHAT_PARTITION_JOB)

    await expect(worker.stop()).resolves.toBeUndefined()
  })

  it("registers media.checks with a bounded retry policy so infra throws retry (not dead-letter)", async () => {
    const handle = buildJobs()
    const calls: {
      name: string
      options?: { retryLimit?: number; retryBackoff?: boolean; policy?: string }
    }[] = []
    const original = handle.jobs.createQueue.bind(handle.jobs)
    handle.jobs.createQueue = (name, options) => {
      calls.push({ name, ...(options ? { options } : {}) })
      return original(name, options)
    }
    const seams = await buildSeams()
    const worker = await buildWorker(handle, seams)
    await worker.start()

    const mediaQueue = calls.find((c) => c.name === MEDIA_CHECKS_JOB)
    expect(mediaQueue?.options).toEqual({ policy: "short", retryLimit: 5, retryBackoff: true })
    expect(calls.find((c) => c.name === ANON_HOLD_RELEASE_JOB)?.options).toEqual({ policy: "short" })
    expect(calls.find((c) => c.name === ORPHAN_SWEEP_JOB)?.options).toBeUndefined()

    await worker.stop()
  })
})

describe("F25: post-success hold-release hook is gated on anon+held report state", () => {
  function heldView(overrides: Partial<HeldReportView> = {}): HeldReportView {
    return {
      id: "report-1",
      reporterUserId: null,
      anonSessionId: "anontok-1",
      status: "held",
      visibility: "public",
      lat: 34.1,
      lng: -118.35,
      deletedAt: null,
      ...overrides,
    }
  }

  function makeAnonHoldRepo(report: HeldReportView): AnonHoldReleaseRepo {
    return {
      findReport: () => Promise.resolve(report),
      findMedia: () => Promise.resolve([{ id: "m1", status: "ready" }]),
      countOpenAbuseFlags: () => Promise.resolve(0),
      publishHeldReport: () => Promise.resolve(true),
      findHeldAnonReportIds: () => Promise.resolve([]),
    }
  }

  async function runMediaJobWith(
    anonHoldRepo: AnonHoldReleaseRepo,
  ): Promise<{ fake: FakeJobs; repo: InMemoryWorkerRepo }> {
    const handle = buildJobs()
    const fake = handle.jobs as unknown as FakeJobs
    const storage = new FakeStorage()
    const repo = new InMemoryWorkerRepo()
    const reportId = "report-1"
    repo.seed({
      id: "m1",
      uploadId: "u1",
      kind: "image",
      r2Key: "uploads/m1",
      reportId,
      status: "validating",
    })
    const bytes = await fx.makeValidPng()
    await storage.put("uploads/m1", bytes, { contentType: "image/png" })

    const seams: WorkerSeams = {
      storage,
      abuseChecks: new FakeAbuseChecks(),
      limits: loadLimits({}),
      download: makeDownloader(storage),
      dbHandle: undefined,
      repo,
      anonHoldRepo,
      findPhashDuplicate: undefined,
      report: () => {},
      close: () => Promise.resolve(),
    }
    const worker = await buildWorker(handle, seams)
    await worker.start()

    await handle.jobs.enqueue(MEDIA_CHECKS_JOB, {
      mediaId: "m1",
      uploadId: "u1",
      r2Key: "uploads/m1",
      kind: "image",
    })

    await worker.stop()
    return { fake, repo }
  }

  it("does NOT enqueue anon.hold.release for an authenticated (non-anon) report's media", async () => {
    const anonHoldRepo = makeAnonHoldRepo(
      heldView({ reporterUserId: "user-123", status: "published" }),
    )
    const { fake, repo } = await runMediaJobWith(anonHoldRepo)

    expect(repo.get("m1")!.status).toBe("ready")
    expect(fake.jobsFor(ANON_HOLD_RELEASE_JOB)).toHaveLength(0)
  })

  it("does NOT enqueue anon.hold.release for an anon report that is not held (e.g. already published)", async () => {
    const anonHoldRepo = makeAnonHoldRepo(heldView({ status: "published" }))
    const { fake, repo } = await runMediaJobWith(anonHoldRepo)

    expect(repo.get("m1")!.status).toBe("ready")
    expect(fake.jobsFor(ANON_HOLD_RELEASE_JOB)).toHaveLength(0)
  })

  it("STILL enqueues anon.hold.release for a genuinely anonymous HELD report (no regression)", async () => {
    const anonHoldRepo = makeAnonHoldRepo(heldView())
    const { fake, repo } = await runMediaJobWith(anonHoldRepo)

    expect(repo.get("m1")!.status).toBe("ready")
    expect(fake.jobsFor(ANON_HOLD_RELEASE_JOB)).toHaveLength(1)
  })
})

describe("buildSeams production storage guard", () => {
  it("THROWS when USE_FAKE_STORAGE is on in production (would silently lose media, issue #39)", async () => {
    await expect(
      buildSeams({ NODE_ENV: "production", USE_FAKE_STORAGE: "1" } as NodeJS.ProcessEnv),
    ).rejects.toThrow(/USE_FAKE_STORAGE must be 0 in production/)
  })

  it("fires on fake storage even when USE_FAKE_ABUSE_NSFW is off (abuse seam is not what is guarded)", async () => {
    await expect(
      buildSeams({
        NODE_ENV: "production",
        USE_FAKE_STORAGE: "1",
        USE_FAKE_ABUSE_NSFW: "0",
      } as NodeJS.ProcessEnv),
    ).rejects.toThrow(/USE_FAKE_STORAGE/)
  })
})
