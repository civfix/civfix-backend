import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FakeJobs, FakeStorage, type JobHandler } from "@civfix/seams"
import {
  FILING_QUEUE_OPTIONS,
  type FilingQueueName,
  type FilingQueueOptions,
} from "@civfix/api/filings-worker"
import { afterEach, describe, expect, it } from "vitest"
import { startFiler, type Filer } from "../../src/filer.js"
import type { FilerJobs, FilerWorkSettings } from "../../src/jobs.js"
import { FakeFilingsWorker } from "../helpers/fake-filings-worker.js"
import { CONTACT, makeWorkspace } from "../helpers/filer-harness.js"

class RecordingJobs extends FakeJobs implements FilerJobs {
  readonly queues: { name: FilingQueueName; options: FilingQueueOptions }[] = []
  readonly workers: { name: string; settings: FilerWorkSettings }[] = []
  start(): Promise<void> {
    return Promise.resolve()
  }
  stop(): Promise<void> {
    return Promise.resolve()
  }
  createQueue(name: FilingQueueName, options: FilingQueueOptions): Promise<void> {
    this.queues.push({ name, options })
    return Promise.resolve()
  }
  override work(name: string, handler: JobHandler, settings?: FilerWorkSettings): Promise<void> {
    if (settings !== undefined) this.workers.push({ name, settings })
    return super.work(name, handler)
  }
}

let dir: string
let filer: Filer | undefined

afterEach(async () => {
  await filer?.stop()
  await rm(dir, { recursive: true, force: true })
})

describe("starting the filer", () => {
  it("T30: creates filing.run with exactly its FILING_QUEUE_OPTIONS entry and works it one job at a time", async () => {
    dir = await mkdtemp(join(tmpdir(), "filer-start-"))
    const jobs = new RecordingJobs()

    filer = await startFiler({
      filings: new FakeFilingsWorker(),
      jobs,
      storage: new FakeStorage(),
      config: {
        workspaceDir: await makeWorkspace(dir),
        dryRun: false,
        contact: { ...CONTACT },
        filerGid: null,
        scriptTimeoutMs: 1000,
      },
      runner: { filerShell: "/nonexistent", nodeBinary: "node", kitRunScript: "/nonexistent" },
      log: () => {},
      report: () => {},
    })

    const run = jobs.queues.filter((q) => q.name === "filing.run")
    expect(run).toHaveLength(1)
    expect(run[0]?.options).toStrictEqual(FILING_QUEUE_OPTIONS["filing.run"])
    expect(run[0]?.options).toStrictEqual({ policy: "short", retryLimit: 0, expireInSeconds: 3600 })
    expect(jobs.workers).toEqual([{ name: "filing.run", settings: { batchSize: 1 } }])
  })
})
