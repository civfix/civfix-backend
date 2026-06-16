/**
 * Worker wiring (offline): builds over FakeJobs + offline seams, registers handlers + schedules, and
 * shuts down cleanly. No real queue, no DB (USE_FAKE_* default ON in the test env).
 */

import { describe, it, expect } from "vitest"
import {
  buildWorker,
  ORPHAN_SWEEP_JOB,
  CHAT_PARTITION_JOB,
  ANON_HOLD_RELEASE_JOB,
} from "../../src/worker.js"
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

  it("registers media.checks with a bounded retry policy so infra throws retry (not dead-letter)", async () => {
    // Spy on createQueue to assert the media.checks queue is created with retryLimit + retryBackoff.
    // Without a retry policy a thrown (infra) handler would NOT retry (pg-boss default retryLimit 0).
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
    // policy "short" MUST match the API's creator (singletonKey dedup is "short"-only); without it the
    // worker's updateQueue would rewrite the policy to "standard" and break dedup on boot.
    expect(mediaQueue?.options).toEqual({ policy: "short", retryLimit: 5, retryBackoff: true })
    // anon.hold.release is enqueued with a singletonKey, so it is created with policy "short" (no retry).
    expect(calls.find((c) => c.name === ANON_HOLD_RELEASE_JOB)?.options).toEqual({ policy: "short" })
    // The maintenance queues are created WITHOUT any policy (their handlers do not throw or dedup).
    expect(calls.find((c) => c.name === ORPHAN_SWEEP_JOB)?.options).toBeUndefined()

    await worker.stop()
  })
})

describe("buildSeams production storage guard", () => {
  it("THROWS when USE_FAKE_STORAGE is on in production (would silently lose media, issue #39)", async () => {
    // Fake in-memory storage in prod is always empty -> downloads miss -> media is lost (issue #39).
    // The worker must fail boot loudly, mirroring the API's required-creds enforcement. The guard is
    // specifically about STORAGE (not the NSFW seam, which stays togglable pre-launch).
    await expect(
      buildSeams({ NODE_ENV: "production", USE_FAKE_STORAGE: "1" } as NodeJS.ProcessEnv),
    ).rejects.toThrow(/USE_FAKE_STORAGE must be 0 in production/)
  })

  it("fires on fake storage even when USE_FAKE_ABUSE_NSFW is off (abuse seam is not what is guarded)", async () => {
    // Prove the guard keys ONLY on storage: real-abuse + fake-storage in prod still throws the storage
    // error, confirming USE_FAKE_ABUSE_NSFW is left togglable (the intentional pre-launch state).
    await expect(
      buildSeams({
        NODE_ENV: "production",
        USE_FAKE_STORAGE: "1",
        USE_FAKE_ABUSE_NSFW: "0",
      } as NodeJS.ProcessEnv),
    ).rejects.toThrow(/USE_FAKE_STORAGE/)
  })
})
