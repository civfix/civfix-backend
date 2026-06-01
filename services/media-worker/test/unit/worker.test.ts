import { describe, it, expect } from "vitest"
import { buildWorker } from "../../src/worker.js"
import { buildJobs } from "../../src/jobs.js"
import { FakeJobs } from "@civfix/shared/fakes"

describe("media-worker", () => {
  it("module loads and builds a worker over the fake Jobs seam", () => {
    const handle = buildJobs()
    expect(handle.jobs).toBeInstanceOf(FakeJobs)
    const worker = buildWorker(handle)
    expect(worker.jobs).toBe(handle.jobs)
  })

  it("start() then stop() resolve cleanly with the fake (no real queue, no handlers)", async () => {
    const worker = buildWorker()
    await expect(worker.start()).resolves.toBeUndefined()
    await expect(worker.stop()).resolves.toBeUndefined()
  })
})
