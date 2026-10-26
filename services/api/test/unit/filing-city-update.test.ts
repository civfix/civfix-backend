/**
 * GH#173's `filing.city_update` handler (D11, D12) over the memory twins: one classification per
 * trusted message row, claimed once with its effects.
 */

import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import type { AdminReportStatus } from "@civfix/contract"
import { makeApplyCityUpdate } from "../../src/services/filings/city-update-jobs.js"
import type { FilingRecord } from "../../src/services/filings/filing-types.js"
import {
  filingHarness,
  J_GEOID,
  J_NAME,
  PORTAL_HOST,
  PORTAL_URL,
} from "../helpers/filings/filing-harness.js"
import { InMemoryFilingIngestSql } from "../helpers/filings/filing-ingest-sql.memory.js"

const REPORTER = "u-reporter"

interface Classification {
  caseId: string | null
  status: string
  summary: string
  confidence: number
}

function classification(over: Partial<Classification> = {}): Classification {
  return { caseId: null, status: "other", summary: "", confidence: 0.9, ...over }
}

async function world(opts: { reportStatus?: AdminReportStatus; caseId?: string | null } = {}) {
  const h = filingHarness()
  const ingest = new InMemoryFilingIngestSql(h.filings, h.reports)
  const warnings: unknown[] = []
  const handle = makeApplyCityUpdate({
    ingest,
    reports: h.reports,
    notifications: h.notifier,
    chatEmitter: h.emitter,
    logger: { warn: (...args: unknown[]) => void warnings.push(args) },
  })
  await h.filings.replaceRoutes(J_GEOID, [
    {
      category: "graffiti",
      channel: "portal",
      formUrl: PORTAL_URL,
      statusSenderDomains: ["lacity.org"],
    },
  ])
  const R = h.seed({
    referenceCode: "GR-42-000123",
    status: opts.reportStatus ?? "acknowledged",
    reporterId: REPORTER,
  })
  const F = await h.addFiling(
    R.record.id,
    { channel: "portal", routeCategory: "graffiti", portalHost: PORTAL_HOST },
    { status: "submitted", method: "script", submittedAt: new Date(), caseId: opts.caseId ?? null },
  )

  async function message(filing: FilingRecord, trusted = true) {
    const row = await h.filings.insertMessageIfAbsent({
      filingId: filing.id,
      inboundEmailId: randomUUID(),
      trusted,
    })
    return row!
  }

  function send(filingMessageId: string, c: Classification | Record<string, unknown>) {
    return handle({ filingMessageId, classification: c })
  }

  const filing = (id = F.id) => h.filings.filings.get(id)!
  const row = (id: string) => h.filings.messages.find((m) => m.id === id)!
  const status = (reportId = R.record.id) => h.reports.reports.get(reportId)!.record.status
  const notes = (reportId = R.record.id) =>
    (h.reports.timeline.get(reportId) ?? []).map((t) => ({ note: t.note, kind: t.kind }))

  return { h, ingest, warnings, R, F, message, send, filing, row, status, notes }
}

describe("filing.city_update effects", () => {
  it("T20: received 1-999 at 0.9 fills F's caseId with the public note and applies the row", async () => {
    const w = await world()
    const m = await w.message(w.F)

    await w.send(m.id, classification({ status: "received", caseId: "1-999" }))

    expect(w.filing().caseId).toBe("1-999")
    expect(w.notes()).toEqual([{ note: `${J_NAME} received request 1-999`, kind: "reply" }])
    expect(w.row(m.id).appliedAt).not.toBeNull()
  })

  it("T21: received keeps an existing caseId, and a caseId outside D7's pattern counts as none", async () => {
    const kept = await world({ caseId: "1-111" })
    const m1 = await kept.message(kept.F)
    await kept.send(m1.id, classification({ status: "received", caseId: "1-999" }))
    expect(kept.filing().caseId).toBe("1-111")
    expect(kept.notes()).toEqual([])

    const junk = await world()
    const m2 = await junk.message(junk.F)
    await junk.send(m2.id, classification({ status: "received", caseId: "<x>" }))
    expect(junk.filing().caseId).toBeNull()
    expect(junk.notes()).toEqual([])
  })

  it("T22: in_progress at 0.9 on F moves R to in_progress with the note and the in-progress push", async () => {
    const w = await world()
    const m = await w.message(w.F)

    await w.send(m.id, classification({ status: "in_progress" }))

    expect(w.status()).toBe("in_progress")
    expect(w.notes()).toEqual([{ note: `${J_NAME} is working on this request`, kind: "status" }])
    expect(w.h.notifier.sent).toEqual([
      {
        userId: REPORTER,
        type: "report_update",
        title: "Your report is in progress",
        body: "The city is working on your report.",
        link: `/reports/${w.R.record.id}`,
      },
    ])
  })

  it("T23: in_progress at 0.9 on an email-channel filing changes no status and writes no note", async () => {
    const w = await world()
    const other = w.h.seed({ status: "acknowledged", category: "trash" })
    const E = await w.h.addFiling(
      other.record.id,
      { category: "trash", channel: "email" },
      { status: "submitted", method: "email", submittedAt: new Date() },
    )
    const m = await w.message(E)

    await w.send(m.id, classification({ status: "in_progress" }))

    expect(w.status(other.record.id)).toBe("acknowledged")
    expect(w.notes(other.record.id)).toEqual([])
  })

  it("T24: closed at 0.9 on F resolves R, sets city_closed_at, writes the note and sends the resolved push", async () => {
    const w = await world()
    const m = await w.message(w.F)

    await w.send(m.id, classification({ status: "closed" }))

    expect(w.status()).toBe("resolved")
    expect(w.filing().cityClosedAt).toBeInstanceOf(Date)
    expect(w.notes()).toEqual([{ note: `${J_NAME} closed the request`, kind: "done" }])
    expect(w.h.notifier.sent).toEqual([
      {
        userId: REPORTER,
        type: "report_update",
        title: "Your report is resolved",
        body: "Your report has been marked resolved.",
        link: `/reports/${w.R.record.id}`,
      },
    ])
  })

  it("T25: closed while R is published (re-moderated) flags the row and changes nothing", async () => {
    const w = await world({ reportStatus: "published" })
    const m = await w.message(w.F)

    await w.send(m.id, classification({ status: "closed" }))

    expect(w.row(m.id).flagged).toBe(true)
    expect(w.status()).toBe("published")
    expect(w.filing().cityClosedAt).toBeNull()
    expect(w.h.notifier.sent).toEqual([])
  })

  it("T26: needs_info moves F to needs_human / city_needs_info with the summary, keeps its caseId, and writes nothing public", async () => {
    const w = await world({ caseId: "1-111" })
    const m = await w.message(w.F)

    await w.send(m.id, classification({ status: "needs_info", summary: "Need cross street" }))

    expect(w.filing()).toMatchObject({
      status: "needs_human",
      reason: "city_needs_info",
      reasonDetail: "Need cross street",
      caseId: "1-111",
    })
    expect(w.notes()).toEqual([])
    expect(w.h.emitter.events).toEqual([])
  })

  it("T27: other at 0.9 changes nothing public and stores the summary on the row", async () => {
    const w = await world()
    const m = await w.message(w.F)

    await w.send(m.id, classification({ status: "other", summary: "Thanks" }))

    expect(w.notes()).toEqual([])
    expect(w.h.emitter.events).toEqual([])
    expect(w.h.notifier.sent).toEqual([])
    expect(w.row(m.id).summary).toBe("Thanks")
  })

  it("T28: closed at 0.69 flags and applies the row and leaves R unchanged", async () => {
    const w = await world()
    const m = await w.message(w.F)

    await w.send(m.id, classification({ status: "closed", confidence: 0.69 }))

    expect(w.row(m.id)).toMatchObject({ flagged: true, appliedAt: expect.any(Date) })
    expect(w.status()).toBe("acknowledged")
  })

  it("T29: a confidence of 1.5 or a status of escalated flags and applies the row and changes nothing else", async () => {
    for (const bad of [
      classification({ status: "closed", confidence: 1.5 }),
      classification({ status: "escalated" }),
    ]) {
      const w = await world()
      const m = await w.message(w.F)

      await w.send(m.id, bad)

      expect(w.row(m.id)).toMatchObject({ flagged: true, appliedAt: expect.any(Date) })
      expect(w.status()).toBe("acknowledged")
      expect(w.filing()).toMatchObject({ status: "submitted", caseId: null, cityClosedAt: null })
      expect(w.notes()).toEqual([])
      expect(w.h.notifier.sent).toEqual([])
    }
  })

  it("T30: an update for an untrusted row changes nothing and leaves applied_at null", async () => {
    const w = await world()
    const m = await w.message(w.F, false)

    await w.send(m.id, classification({ status: "closed" }))

    expect(w.row(m.id)).toMatchObject({ appliedAt: null, classification: null, summary: null })
    expect(w.status()).toBe("acknowledged")
    expect(w.notes()).toEqual([])
  })

  it("T31: the same update twice in sequence, then two at once for a fresh row, applies once each time with one push", async () => {
    const sequential = await world()
    const m1 = await sequential.message(sequential.F)
    await sequential.send(m1.id, classification({ status: "in_progress" }))
    await sequential.send(m1.id, classification({ status: "in_progress" }))
    expect(sequential.notes()).toHaveLength(1)
    expect(sequential.h.notifier.sent).toHaveLength(1)

    const concurrent = await world()
    const m2 = await concurrent.message(concurrent.F)
    await Promise.all([
      concurrent.send(m2.id, classification({ status: "closed" })),
      concurrent.send(m2.id, classification({ status: "closed" })),
    ])
    expect(concurrent.notes()).toHaveLength(1)
    expect(concurrent.h.notifier.sent).toHaveLength(1)
  })

  it("T42: in_progress while R is already in_progress flags and applies the row with no note and no push", async () => {
    const w = await world({ reportStatus: "in_progress" })
    const m = await w.message(w.F)

    await w.send(m.id, classification({ status: "in_progress" }))

    expect(w.row(m.id)).toMatchObject({ flagged: true, appliedAt: expect.any(Date) })
    expect(w.status()).toBe("in_progress")
    expect(w.notes()).toEqual([])
    expect(w.h.notifier.sent).toEqual([])
  })

  it("T43: needs_info while F is already needs_human / city_needs_info flags and applies the row and keeps its reasonDetail", async () => {
    const w = await world()
    w.h.filings.filings.set(w.F.id, {
      ...w.filing(),
      status: "needs_human",
      reason: "city_needs_info",
      reasonDetail: "Need the address",
    })
    const m = await w.message(w.F)

    await w.send(m.id, classification({ status: "needs_info", summary: "Need cross street" }))

    expect(w.row(m.id)).toMatchObject({ flagged: true, appliedAt: expect.any(Date) })
    expect(w.filing().reasonDetail).toBe("Need the address")
  })

  it("T44: an update naming no row changes nothing and resolves without throwing", async () => {
    const w = await world()
    const before = structuredClone([...w.h.filings.messages])

    await expect(
      w.send(randomUUID(), classification({ status: "closed" })),
    ).resolves.toBeUndefined()

    expect(w.h.filings.messages).toEqual(before)
    expect(w.status()).toBe("acknowledged")
    expect(w.notes()).toEqual([])
  })
})
