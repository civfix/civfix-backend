import { describe, expect, it } from "vitest"
import { FakeStorage } from "@civfix/shared/fakes"
import { MEDIA_CHECKS_JOB } from "@civfix/api/queue-names"
import { loadLimits } from "../../src/config.js"
import { parsePayload } from "../../src/jobs/media-checks.js"
import { runStuckSweep } from "../../src/jobs/stuck-sweep.js"
import { InMemoryMediaWorkerRepository } from "../helpers/in-memory-media-worker-repository.js"

const limits = loadLimits({})
const NOW = new Date("2026-06-01T12:00:00Z")
const STUCK_SINCE = new Date(NOW.getTime() - limits.stuckMediaTtlMs - 60_000)
const FINALIZED_ETAG = "5d41402abc4b2a76b9719d911017c592"

async function sweepOnce(repo: InMemoryMediaWorkerRepository): Promise<unknown[]> {
  const payloads: unknown[] = []
  await runStuckSweep({
    repo,
    jobs: {
      enqueue: (name: string, data: unknown) => {
        if (name === MEDIA_CHECKS_JOB) payloads.push(data)
        return Promise.resolve("job-id")
      },
    },
    storage: new FakeStorage(),
    limits,
    now: () => NOW,
    log: () => {},
  })
  return payloads
}

function seedStuck(repo: InMemoryMediaWorkerRepository, uploadEtag: string | null): void {
  repo.now = () => NOW
  repo.seed({
    id: "stuck-1",
    uploadId: "u1",
    kind: "image",
    r2Key: "uploads/s1",
    status: "validating",
    createdAt: STUCK_SINCE,
    finalizedAt: STUCK_SINCE,
    uploadEtag,
  })
}

describe("media.stuck.sweep keeps the finalize-time overwrite check", () => {
  it("requeues media.checks with the upload etag recorded at finalize", async () => {
    const repo = new InMemoryMediaWorkerRepository()
    seedStuck(repo, FINALIZED_ETAG)

    const payloads = await sweepOnce(repo)

    expect(payloads).toEqual([
      {
        mediaId: "stuck-1",
        uploadId: "u1",
        r2Key: "uploads/s1",
        kind: "image",
        uploadEtag: FINALIZED_ETAG,
      },
    ])
    expect(parsePayload(payloads[0])?.uploadEtag).toBe(FINALIZED_ETAG)
  })

  it("a row finalized before the etag was stored requeues with no etag, as before", async () => {
    const repo = new InMemoryMediaWorkerRepository()
    seedStuck(repo, null)

    const payloads = await sweepOnce(repo)

    expect(payloads).toHaveLength(1)
    expect(parsePayload(payloads[0])?.uploadEtag).toBeNull()
  })
})
