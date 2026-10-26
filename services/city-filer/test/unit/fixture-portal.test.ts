import { createHash } from "node:crypto"
import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { FILING_RESULT_JOB, FilingResultPayloadSchema } from "@civfix/api/filings-worker"
import { reconcileRunningFilings } from "../../src/reconcile.js"
import { runScript } from "../../src/script.js"
import { PORTAL_HOST } from "../helpers/fake-filings-worker.js"
import { filerHarness, type FilerHarness } from "../helpers/filer-harness.js"
import { startFixturePortal, type FixturePortal } from "../fixtures/portal.js"

let h: FilerHarness
let portal: FixturePortal

afterEach(async () => {
  await portal?.close()
  await h?.close()
})

async function setUp(dryRun = false) {
  h = await filerHarness({ dryRun })
  portal = await startFixturePortal()
  const script = await h.installFixtureScript()
  const f = h.filings.add({ packet: { formUrl: portal.formUrl } })
  return { f, script, sha256: createHash("sha256").update(script).digest("hex") }
}

const scriptRuns = () =>
  h.logs.filter((l) => l.line === "filer: script finished").map((l) => l.fields)
const key = (id: string, ext: string) => new RegExp(`^filings/${id}/[0-9a-f-]{36}\\.${ext}$`)

describe("the fixture portal on a real Chromium", () => {
  it("T9: a confirmed SR-0001 is a valid submitted result with its screenshots and the script copy", async () => {
    const { f, script, sha256 } = await setUp()

    await h.run(f.id, 1)
    const [result] = h.results()
    expect(FilingResultPayloadSchema.safeParse(result).success).toBe(true)
    expect(result).toMatchObject({ runId: f.runId, outcome: "submitted", caseId: "SR-0001" })
    expect(result?.scriptVersion).toBe(sha256.slice(0, 12))
    const shots = result?.evidence.filter((e) => e.kind === "screenshot") ?? []
    const copies = result?.evidence.filter((e) => e.kind === "script") ?? []
    expect(shots.length).toBeGreaterThan(0)
    for (const e of shots) expect(e.r2Key).toMatch(key(f.id, "png"))
    expect(copies.map((e) => e.r2Key)).toEqual([expect.stringMatching(key(f.id, "mjs"))])
    expect(Buffer.from(h.storage.objects.get(copies[0]?.r2Key ?? "")?.bytes ?? [])).toEqual(script)
    expect(portal.submissions).toHaveLength(1)
  })

  it("T10: a similar request SR-0042 is linked_existing with no submit; a --dry-run run prints the sentinel at result()", async () => {
    const { f, sha256 } = await setUp()
    portal.mode = "similar"

    await h.run(f.id, 1)
    expect(h.results().map((r) => [r.outcome, r.caseId])).toEqual([["linked_existing", "SR-0042"]])
    const runDir = h.runDir(f.id, f.runId)
    const opts = {
      runDir,
      host: PORTAL_HOST,
      dryRun: true,
      scriptSha256: sha256,
      timeoutMs: 60_000,
    }
    expect(await runScript(h.runner, opts)).toMatchObject({
      exitCode: 0,
      sentinel: true,
      marker: false,
    })
    expect(portal.submissions).toEqual([])
  })

  it("T11: under FILER_DRY_RUN nothing is submitted, it is needs_human / dry_run with evidence, and the sentinel came through the pipe", async () => {
    const { f } = await setUp(true)

    await h.run(f.id, 1)
    expect(portal.submissions).toEqual([])
    expect(h.endings()).toEqual(["needs_human/dry_run"])
    expect(h.results()[0]?.evidence.some((e) => e.kind === "screenshot")).toBe(true)
    expect(scriptRuns()).toMatchObject([{ exitCode: 0, sentinel: true, marker: false }])
  })

  it('T12: under FILER_DRY_RUN a similar request SR-0042 is needs_human / dry_run, "Would link to SR-0042"', async () => {
    const { f } = await setUp(true)
    portal.mode = "similar"

    await h.run(f.id, 1)
    expect(h.endings()).toEqual(["needs_human/dry_run"])
    expect(h.results()[0]?.reasonDetail).toBe("Would link to SR-0042")
  })

  it("T14: a script that exits 1 before the marker is failed / portal_error", async () => {
    const { f } = await setUp()
    portal.mode = "no_form"

    await h.run(f.id, 1)
    expect(h.endings()).toEqual(["failed/portal_error"])
    expect(scriptRuns()).toMatchObject([{ exitCode: 1, marker: false }])
  })

  it("T15: exiting 1 after the marker, then confirming case id <b>, are both failed / uncertain_submission", async () => {
    const { f } = await setUp()
    portal.mode = "submit_error"
    await h.run(f.id, 1)
    portal.mode = "bad_case_id"
    await h.run(h.filings.add({ packet: { formUrl: portal.formUrl } }).id, 1)

    expect(h.endings()).toEqual(["failed/uncertain_submission", "failed/uncertain_submission"])
    expect(portal.submissions).toHaveLength(2)
    expect(await readdir(join(h.runDir(f.id, f.runId), "out"))).toContain(".submit-clicked")
  })

  it("T31: the T9 run's and the boot reconciler's filing.result sends are keyed <filingId>:<runId>", async () => {
    const { f } = await setUp()
    await h.run(f.id, 1)
    // The API applied the T9 result, so only the other filing is still running at the next boot.
    f.status = "done"
    const stale = h.filings.add({
      status: "running",
      attempts: 2,
      runId: "0b9f3a3e-6f5e-4c1e-8f43-3f1f8a9e2d10",
    })
    await reconcileRunningFilings({
      filings: h.filings,
      jobs: h.jobs,
      config: h.config,
      log: () => {},
    })

    expect(h.jobs.jobsFor(FILING_RESULT_JOB).map((j) => j.opts?.singletonKey)).toEqual([
      `${f.id}:${f.runId}`,
      `${stale.id}:${stale.runId}`,
    ])
  })
})
