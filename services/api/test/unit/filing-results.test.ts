import { describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { renderMessage } from "../../src/i18n/renderMessage.js"
import type { MessageKey } from "../../src/i18n/messages/en.js"
import type { FilingResultPayload } from "../../src/services/filings/filings-worker.js"
import type { FilingRecord } from "../../src/services/filings/filing-types.js"
import {
  filingHarness,
  J_GEOID,
  J_NAME,
  PORTAL_URL,
  type FilingHarness,
} from "../helpers/filings/filing-harness.js"

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS

interface Running {
  h: FilingHarness
  reportId: string
  filingId: string
  runId: string
}

/** A portal filing on (J, NULL), claimed for attempt 1, with the jobs log cleared. */
async function running(): Promise<Running> {
  const h = filingHarness({ automatic: true, now: new Date("2026-06-06T12:00:00.000Z") })
  await h.filings.replaceRoutes(J_GEOID, [
    { category: null, channel: "portal", formUrl: PORTAL_URL },
  ])
  const r = h.seed({ status: "published" })
  const out = await h.svc.create({ reportId: r.record.id, actorId: "op-1" })
  if (out.kind !== "created") throw new Error("not created")
  const claim = await h.filings.claim(out.filing.id, 1)
  if (claim === null) throw new Error("not claimed")
  h.jobs.reset()
  return { h, reportId: r.record.id, filingId: out.filing.id, runId: claim.runId }
}

async function reclaim(run: Running, attempt: number): Promise<void> {
  const claim = await run.h.filings.claim(run.filingId, attempt)
  if (claim === null) throw new Error(`attempt ${attempt} not claimed`)
  run.runId = claim.runId
}

function payload(
  run: Running,
  attempt: number,
  over: Partial<FilingResultPayload>,
): FilingResultPayload {
  return {
    filingId: run.filingId,
    runId: run.runId,
    attempt,
    outcome: "submitted",
    dryRun: false,
    evidence: [],
    ...over,
  }
}

function filing(run: Running): FilingRecord {
  const f = run.h.filings.filings.get(run.filingId)
  if (f === undefined) throw new Error("filing missing")
  return { ...f, jurisdictionName: null }
}

function jobs(h: FilingHarness) {
  return h.jobs.enqueued.map((j) => ({ name: j.name, data: j.data, opts: j.opts }))
}

function notificationText(n: { titleKey?: MessageKey; vars?: Record<string, unknown> }): string {
  if (n.titleKey === undefined) throw new Error("notification has no titleKey")
  return renderMessage("en", n.titleKey, n.vars as Record<string, string>)
}

describe("applyFilingResult", () => {
  it("C15: a submitted run with a case id, a portal case URL and two evidence rows", async () => {
    const run = await running()
    const evidence = [
      { r2Key: `filings/${run.filingId}/a.png`, kind: "screenshot" as const, label: "Form" },
      { r2Key: `filings/${run.filingId}/b.mjs`, kind: "script" as const, label: "Script" },
    ]
    const out = await run.h.svc.applyFilingResult(
      payload(run, 1, {
        caseId: "1-234",
        caseUrl: "https://myla311.lacity.gov/s/case/1",
        scriptVersion: "abcdef012345",
        evidence,
      }),
    )
    expect(out).toEqual({ applied: true })
    expect(filing(run)).toMatchObject({
      status: "submitted",
      method: "script",
      caseId: "1-234",
      caseUrl: "https://myla311.lacity.gov/s/case/1",
      scriptVersion: "abcdef012345",
      dryRun: false,
    })
    expect(run.h.filings.timeline.map((t) => t.note)).toEqual([
      `Filed with ${J_NAME} · Request 1-234`,
    ])
    expect(run.h.filings.evidence.map((e) => e.r2Key)).toEqual(evidence.map((e) => e.r2Key))
    expect(run.h.reports.reports.get(run.reportId)?.record.status).toBe("acknowledged")
    expect(run.h.notifier.sent.map(notificationText)).toEqual([`Your report was sent to ${J_NAME}`])
  })

  it("C16: a case URL off the portal host or not https is stored null", async () => {
    for (const caseUrl of [
      "https://evil.example/x",
      "http://myla311.lacity.gov/x",
      "https://lacity.gov/x",
      "https://other.myla311.lacity.gov/x",
    ]) {
      const run = await running()
      expect(await run.h.svc.applyFilingResult(payload(run, 1, { caseUrl }))).toEqual({
        applied: true,
      })
      expect(filing(run).caseUrl, caseUrl).toBeNull()
    }
  })

  it("C17: a submitted run with a malformed case id is an uncertain submission, never retried", async () => {
    const run = await running()
    await run.h.svc.applyFilingResult(payload(run, 1, { caseId: "<b>" }))
    expect(filing(run)).toMatchObject({
      status: "needs_human",
      reason: "uncertain_submission",
      caseId: null,
    })
    expect(run.h.jobs.enqueued).toEqual([])
    expect(run.h.filings.timeline).toEqual([])
  })

  it("C18: a linked run notes the existing request", async () => {
    const run = await running()
    await run.h.svc.applyFilingResult(
      payload(run, 1, { outcome: "linked_existing", caseId: "1-77" }),
    )
    expect(filing(run)).toMatchObject({ status: "linked_existing", caseId: "1-77" })
    expect(run.h.filings.timeline.map((t) => t.note)).toEqual([`Linked to ${J_NAME} request 1-77`])
    expect(run.h.reports.reports.get(run.reportId)?.record.status).toBe("acknowledged")
  })

  it("C19: portal errors re-queue after 10 then 30 minutes, then exhaust the attempts", async () => {
    const run = await running()
    const t0 = run.h.clock.now.getTime()
    await run.h.svc.applyFilingResult(
      payload(run, 1, { outcome: "failed", reason: "portal_error" }),
    )
    expect(filing(run)).toMatchObject({
      status: "queued",
      attempts: 1,
      nextAttemptAt: new Date(t0 + 10 * MINUTE_MS),
    })
    expect(jobs(run.h)).toEqual([
      {
        name: "filing.run",
        data: { filingId: run.filingId, attempt: 2 },
        opts: { singletonKey: run.filingId, startAfter: 600 },
      },
    ])

    run.h.jobs.reset()
    await reclaim(run, 2)
    await run.h.svc.applyFilingResult(
      payload(run, 2, { outcome: "failed", reason: "portal_error" }),
    )
    expect(filing(run)).toMatchObject({
      status: "queued",
      attempts: 2,
      nextAttemptAt: new Date(t0 + 30 * MINUTE_MS),
    })
    expect(jobs(run.h)).toEqual([
      {
        name: "filing.run",
        data: { filingId: run.filingId, attempt: 3 },
        opts: { singletonKey: run.filingId, startAfter: 1800 },
      },
    ])

    run.h.jobs.reset()
    await reclaim(run, 3)
    await run.h.svc.applyFilingResult(
      payload(run, 3, { outcome: "failed", reason: "portal_error" }),
    )
    expect(filing(run)).toMatchObject({ status: "needs_human", reason: "attempts_exhausted" })
    expect(run.h.jobs.enqueued).toEqual([])
  })

  it("C20: an immediate needs_human reason, an uncertain failure and the filer's cancel send no job", async () => {
    const captcha = await running()
    await captcha.h.svc.applyFilingResult(
      payload(captcha, 1, { outcome: "needs_human", reason: "captcha" }),
    )
    expect(filing(captcha)).toMatchObject({ status: "needs_human", reason: "captcha" })
    expect(captcha.h.jobs.enqueued).toEqual([])

    const uncertain = await running()
    await uncertain.h.svc.applyFilingResult(
      payload(uncertain, 1, { outcome: "failed", reason: "uncertain_submission" }),
    )
    expect(filing(uncertain)).toMatchObject({
      status: "needs_human",
      reason: "uncertain_submission",
    })
    expect(uncertain.h.jobs.enqueued).toEqual([])

    const cancelled = await running()
    await cancelled.h.svc.applyFilingResult(payload(cancelled, 1, { outcome: "cancelled" }))
    expect(filing(cancelled)).toMatchObject({ status: "cancelled" })
    expect(cancelled.h.jobs.enqueued).toEqual([])
    expect(cancelled.h.filings.timeline).toEqual([])
  })

  it("C21: Claude being unavailable re-queues without spending the attempt, then gives up after 6 hours", async () => {
    const run = await running()
    const t0 = run.h.clock.now
    await run.h.svc.applyFilingResult(
      payload(run, 1, { outcome: "failed", reason: "ai_unavailable" }),
    )
    expect(filing(run)).toMatchObject({
      status: "queued",
      attempts: 0,
      aiWaitSince: t0,
      nextAttemptAt: new Date(t0.getTime() + 30 * MINUTE_MS),
    })
    expect(jobs(run.h)).toEqual([
      {
        name: "filing.run",
        data: { filingId: run.filingId, attempt: 1 },
        opts: { singletonKey: run.filingId, startAfter: 1800 },
      },
    ])

    run.h.jobs.reset()
    run.h.clock.now = new Date(t0.getTime() + 6 * HOUR_MS + MINUTE_MS)
    await reclaim(run, 1)
    await run.h.svc.applyFilingResult(
      payload(run, 1, { outcome: "failed", reason: "ai_unavailable" }),
    )
    expect(filing(run)).toMatchObject({ status: "needs_human", reason: "ai_unavailable" })
    expect(run.h.jobs.enqueued).toEqual([])
  })

  it("C22: a stale attempt and a redelivered success change nothing", async () => {
    const run = await running()
    await run.h.svc.applyFilingResult(
      payload(run, 1, { outcome: "failed", reason: "portal_error" }),
    )
    await reclaim(run, 2)
    run.h.jobs.reset()
    const before = filing(run)
    expect(await run.h.svc.applyFilingResult(payload(run, 1, { caseId: "1-1" }))).toEqual({
      applied: false,
    })
    expect(filing(run)).toEqual(before)
    expect(run.h.warnings).toHaveLength(1)

    const success = payload(run, 2, {
      caseId: "1-2",
      evidence: [{ r2Key: `filings/${run.filingId}/c.png`, kind: "screenshot", label: "Done" }],
    })
    expect(await run.h.svc.applyFilingResult(success)).toEqual({ applied: true })
    expect(await run.h.svc.applyFilingResult(success)).toEqual({ applied: false })
    expect(run.h.filings.timeline).toHaveLength(1)
    expect(run.h.notifier.sent).toHaveLength(1)
    expect(run.h.filings.evidence).toHaveLength(1)
  })

  it("C23: a success for a report removed during the run records the filing only", async () => {
    const run = await running()
    const seeded = run.h.reports.reports.get(run.reportId)!
    seeded.record.status = "rejected"
    seeded.deletedAt = new Date()
    const out = await run.h.svc.applyFilingResult(payload(run, 1, { caseId: "1-9" }))
    expect(out).toEqual({ applied: true })
    expect(filing(run).status).toBe("submitted")
    expect(seeded.record.status).toBe("rejected")
    expect(run.h.filings.timeline).toEqual([])
    expect(run.h.notifier.sent).toEqual([])
    expect(run.h.emitter.events).toEqual([])
  })

  it("C37: an unknown outcome or an evidence item without r2Key is a validation error and changes nothing", async () => {
    const run = await running()
    const before = filing(run)
    await expect(
      run.h.svc.applyFilingResult({ ...payload(run, 1, {}), outcome: "done" }),
    ).rejects.toMatchObject({ code: "VALIDATION" })
    await expect(
      run.h.svc.applyFilingResult({
        ...payload(run, 1, {}),
        evidence: [{ kind: "screenshot", label: "No key" }],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" })
    expect(filing(run)).toEqual(before)
    expect(run.h.jobs.enqueued).toEqual([])
  })

  it("C38: reasonDetail is cut to 500 characters", async () => {
    const run = await running()
    const detail = "x".repeat(600)
    await run.h.svc.applyFilingResult(
      payload(run, 1, { outcome: "needs_human", reason: "missing_info", reasonDetail: detail }),
    )
    expect(filing(run)).toMatchObject({
      status: "needs_human",
      reason: "missing_info",
      reasonDetail: detail.slice(0, 500),
    })
  })

  it("a payload for a filing that does not exist is not applied", async () => {
    const run = await running()
    const out = await run.h.svc.applyFilingResult({
      ...payload(run, 1, {}),
      filingId: randomUUID(),
    })
    expect(out).toEqual({ applied: false })
    expect(run.h.warnings).toHaveLength(1)
  })
})
