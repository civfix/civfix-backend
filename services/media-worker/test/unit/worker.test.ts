/**
 * Worker wiring (offline): builds over FakeJobs + offline seams, registers handlers + schedules, and
 * shuts down cleanly. No real queue, no DB (USE_FAKE_* default ON in the test env).
 */

import { describe, it, expect } from "vitest"
import { buildWorker, ORPHAN_SWEEP_JOB, CHAT_PARTITION_JOB } from "../../src/worker.js"
import { buildJobs } from "../../src/jobs.js"
import { buildSeams } from "../../src/seams.js"
import { MEDIA_CHECKS_JOB } from "@civfix/api/media-repo"
import { FakeJobs } from "@civfix/shared/fakes"

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

    // A handler is registered for media.checks (FakeJobs runs handlers on enqueue).
    const beforeEnqueue = fake.enqueued.length
    await fake.enqueue(MEDIA_CHECKS_JOB, {
      mediaId: "x",
      uploadId: "y",
      r2Key: "uploads/z",
      kind: "image",
    })
    expect(fake.enqueued.length).toBe(beforeEnqueue + 1)

    // Both crons are scheduled.
    const scheduledNames = fake.scheduled.map((s) => s.name)
    expect(scheduledNames).toContain(ORPHAN_SWEEP_JOB)
    expect(scheduledNames).toContain(CHAT_PARTITION_JOB)

    await expect(worker.stop()).resolves.toBeUndefined()
  })
})
