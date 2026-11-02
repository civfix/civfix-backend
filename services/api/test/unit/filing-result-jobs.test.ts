import { randomUUID } from "node:crypto"
import { FakeJobs } from "@civfix/seams"
import { describe, expect, it } from "vitest"
import { makeFilingResultHandler } from "../../src/services/filings/filing-result-jobs.js"
import type { FilingResultPayload } from "../../src/services/filings/filings-worker.js"
import { filingHarness, J_GEOID, PORTAL_URL } from "../helpers/filings/filing-harness.js"

/** A portal filing claimed for attempt 1, with the filing.result worker on its own queue. */
async function running() {
  const h = filingHarness({ automatic: true, now: new Date("2026-06-06T12:00:00.000Z") })
  await h.filings.replaceRoutes(J_GEOID, [
    { category: null, channel: "portal", formUrl: PORTAL_URL },
  ])
  const r = h.seed({ status: "published" })
  const out = await h.svc.create({ reportId: r.record.id, actorId: "op-1" })
  if (out.kind !== "created") throw new Error("not created")
  const claim = await h.filings.claim(out.filing.id, 1)
  if (claim === null) throw new Error("not claimed")
  const applied: { applied: boolean }[] = []
  const apply = async (payload: unknown) => {
    const result = await h.svc.applyFilingResult(payload)
    applied.push(result)
    return result
  }
  const queue = new FakeJobs()
  await queue.work("filing.result", makeFilingResultHandler(apply))
  return { h, reportId: r.record.id, filingId: out.filing.id, runId: claim.runId, applied, queue }
}

function t9Payload(filingId: string, runId: string): FilingResultPayload {
  return {
    filingId,
    runId,
    attempt: 1,
    outcome: "submitted",
    caseId: "SR-0001",
    scriptVersion: "0123456789ab",
    dryRun: false,
    evidence: [
      {
        r2Key: `filings/${filingId}/${randomUUID()}.png`,
        kind: "screenshot",
        label: "01-form.png",
      },
      { r2Key: `filings/${filingId}/${randomUUID()}.mjs`, kind: "script", label: "script.mjs" },
    ],
  }
}

describe("the filing.result worker", () => {
  it("T27: a T9 payload is applied: the filing is submitted as SR-0001 with its evidence and the report acknowledged", async () => {
    const run = await running()
    const payload = t9Payload(run.filingId, run.runId)

    await run.queue.enqueue("filing.result", payload)

    expect(run.queue.jobsFor("filing.result")[0]?.state).toBe("completed")
    expect(run.applied).toEqual([{ applied: true }])
    expect(run.h.filings.filings.get(run.filingId)).toMatchObject({
      status: "submitted",
      caseId: "SR-0001",
    })
    expect(run.h.filings.evidence.map((e) => e.r2Key)).toEqual(payload.evidence.map((e) => e.r2Key))
    expect(run.h.reports.reports.get(run.reportId)?.record.status).toBe("acknowledged")
  })

  it("T28: an evidence key under another filing is rejected unapplied; a result from an older run of the same attempt changes nothing", async () => {
    const run = await running()
    const foreign = {
      ...t9Payload(run.filingId, run.runId),
      evidence: [
        { r2Key: `filings/${randomUUID()}/x.png`, kind: "screenshot" as const, label: "x.png" },
      ],
    }
    await run.queue.enqueue("filing.result", foreign)

    expect(run.queue.jobsFor("filing.result")[0]?.state).toBe("failed")
    expect(run.applied).toEqual([])

    // Claude unavailable requeues without spending the attempt, so the next run claims attempt 1 again.
    await run.h.svc.applyFilingResult({
      filingId: run.filingId,
      runId: run.runId,
      attempt: 1,
      outcome: "failed",
      reason: "ai_unavailable",
      dryRun: false,
      evidence: [],
    })
    const next = await run.h.filings.claim(run.filingId, 1)
    if (next === null) throw new Error("not reclaimed")
    const before = { ...run.h.filings.filings.get(run.filingId) }

    await run.queue.enqueue("filing.result", t9Payload(run.filingId, run.runId))

    expect(run.applied).toEqual([{ applied: false }])
    expect(run.h.filings.filings.get(run.filingId)).toEqual(before)
    expect(run.h.filings.filings.get(run.filingId)?.runId).toBe(next.runId)
    expect(run.h.filings.evidence).toEqual([])
  })
})
