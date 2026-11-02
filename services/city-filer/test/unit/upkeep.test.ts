import { chmod, mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FakeJobs } from "@civfix/seams"
import { FILING_RESULT_JOB, type FilingResultPayload } from "@civfix/api/filings-worker"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { pruneRunDirs } from "../../src/prune.js"
import { reconcileRunningFilings } from "../../src/reconcile.js"
import { FakeFilingsWorker } from "../helpers/fake-filings-worker.js"
import { makeWorkspace } from "../helpers/filer-harness.js"
import { exists } from "../helpers/files.js"

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

  it("T25: a 31-day run directory is deleted, a 29-day one and portals/ are kept, an undeletable entry is logged and skipped", async () => {
    const now = new Date("2026-10-25T12:00:00.000Z")
    const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000)
    const locked = join(await runDir("stuck"), "out", "locked")
    await mkdir(locked)
    await writeFile(join(locked, "shot.png"), "x")
    await chmod(locked, 0o500)
    await mkdir(join(workspace, "portals", "x"))
    for (const [path, days] of [
      [await runDir("old"), 31],
      [await runDir("recent"), 29],
      [join(workspace, "runs", "stuck"), 31],
      [join(workspace, "portals", "x"), 90],
    ] as const) {
      await utimes(path, daysAgo(days), daysAgo(days))
    }
    const logs: string[] = []

    try {
      await pruneRunDirs(workspace, { now, log: (line) => void logs.push(line) })
      expect((await readdir(join(workspace, "runs"))).sort()).toEqual(["recent", "stuck"])
      expect(await exists(join(workspace, "portals", "x"))).toBe(true)
      expect(logs).toContain("filer: could not delete a run directory")
    } finally {
      await chmod(locked, 0o700)
    }
  })
})
