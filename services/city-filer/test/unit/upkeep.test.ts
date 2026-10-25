import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FakeJobs } from "@civfix/seams"
import { FILING_RESULT_JOB, type FilingResultPayload } from "@civfix/api/filings-worker"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { reconcileRunningFilings } from "../../src/reconcile.js"
import { FakeFilingsWorker } from "../helpers/fake-filings-worker.js"
import { makeWorkspace } from "../helpers/filer-harness.js"

let dir: string
let workspace: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "filer-upkeep-"))
  workspace = await makeWorkspace(dir)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function runDir(name: string, marker = false): Promise<string> {
  const path = join(workspace, "runs", name)
  await mkdir(join(path, "out"), { recursive: true })
  if (marker) await writeFile(join(path, "out", ".submit-clicked"), "")
  return path
}

describe("startup and upkeep", () => {
  it("T23: a marker in the current run's directory is uncertain_submission; one only in an older run's is portal_error", async () => {
    const filings = new FakeFilingsWorker()
    const a = filings.add({
      status: "running",
      attempts: 1,
      runId: "1d7d5d5e-2f0b-4a8b-9c8e-0a6a4e4b9a01",
    })
    const b = filings.add({
      status: "running",
      attempts: 2,
      runId: "2e8e6e6f-3a1c-4b9c-8d9f-1b7b5f5c0b02",
    })
    await runDir(`${a.id}-${a.runId}`, true)
    await runDir(`${b.id}-${b.runId}`)
    await runDir(`${b.id}-3f9f7f70-4b2d-4cad-9ea0-2c8c6a6d1c03`, true)
    const jobs = new FakeJobs()

    await reconcileRunningFilings({
      filings,
      jobs,
      config: { workspaceDir: workspace, dryRun: false },
      log: () => {},
    })
    const sent = jobs.jobsFor(FILING_RESULT_JOB).map((j) => j.data as FilingResultPayload)
    expect(sent.map((p) => [p.filingId, p.runId, p.attempt, p.outcome, p.reason])).toEqual([
      [a.id, a.runId, 1, "failed", "uncertain_submission"],
      [b.id, b.runId, 2, "failed", "portal_error"],
    ])
  })
})
