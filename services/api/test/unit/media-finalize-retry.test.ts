import { describe, it, expect } from "vitest"
import { FakeStorage, FakeJobs } from "@civfix/shared/fakes"
import { makeMediaIntakeService } from "../../src/services/media-intake-service.js"
import { MEDIA_CHECKS_JOB } from "../../src/lib/queue-names.js"
import { InMemoryMediaRepository } from "../helpers/media.js"

const SHA = "a".repeat(64)
const DECLARED_BYTES = 32 * 1024
const PROCESSED_BYTES = 9 * 1024

async function finalizedAndProcessed(status: "ready" | "rejected") {
  const repo = new InMemoryMediaRepository()
  const storage = new FakeStorage()
  const jobs = new FakeJobs()
  const service = makeMediaIntakeService({ repo, storage, jobs })
  const created = await service.createUpload(
    { kind: "image", contentType: "image/jpeg", byteSize: DECLARED_BYTES, sha256: SHA },
    {},
  )
  const asset = (await repo.findByUploadId(created.uploadId))!
  await storage.put(asset.r2Key, new Uint8Array(DECLARED_BYTES), { contentType: "image/jpeg" })
  const first = await service.finalize({ uploadId: created.uploadId }, {})

  repo.patch(asset.id, { status, byteSize: PROCESSED_BYTES })
  await storage.delete(asset.r2Key)

  return { service, jobs, created, first }
}

describe("finalize retried after the worker processed the upload", () => {
  it("returns the original media id instead of 422 once the raw upload is gone (ready)", async () => {
    const { service, jobs, created, first } = await finalizedAndProcessed("ready")

    const retry = await service.finalize({ uploadId: created.uploadId }, {})

    expect(retry).toEqual(first)
    expect(jobs.jobsFor(MEDIA_CHECKS_JOB)).toHaveLength(1)
  })

  it("returns the original media id for an already-rejected asset without re-enqueueing", async () => {
    const { service, jobs, created, first } = await finalizedAndProcessed("rejected")

    const retry = await service.finalize({ uploadId: created.uploadId }, {})

    expect(retry).toEqual(first)
    expect(jobs.jobsFor(MEDIA_CHECKS_JOB)).toHaveLength(1)
  })
})
