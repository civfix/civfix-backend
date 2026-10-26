/**
 * GH#173's D12 reopen at the reporter's and the operator's status-change calls, and the operator's
 * status push it shares with the city-update worker, over the memory twins.
 */

import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import { makeAdminReportService } from "../../src/services/admin/admin-report-service.js"
import type { OutboundMailService } from "../../src/services/admin/outbound-mail-service.js"
import { makeApplyCityUpdate } from "../../src/services/filings/city-update-jobs.js"
import { makeReportService } from "../../src/services/report-service.js"
import {
  filingHarness,
  memoryFilingService,
  PORTAL_HOST,
} from "../helpers/filings/filing-harness.js"
import { InMemoryFilingIngestSql } from "../helpers/filings/filing-ingest-sql.memory.js"
import { InMemoryReportRepository } from "../helpers/reports.js"

const OWNER = "u-reporter"
const OPERATOR = "op-1"

/** R filed on a portal and resolved by the city through `filing.city_update` (T24), unless `cityClosed` is off. */
async function world(opts: { cityClosed?: boolean; caseId?: string | null } = {}) {
  const h = filingHarness()
  h.reports.filings = h.filings
  const ingest = new InMemoryFilingIngestSql(h.filings, h.reports)
  const R = h.seed({ status: "acknowledged", referenceCode: "GR-42-000123", reporterId: OWNER })
  const F = await h.addFiling(
    R.record.id,
    { channel: "portal", routeCategory: "graffiti", portalHost: PORTAL_HOST },
    { status: "submitted", method: "script", submittedAt: new Date(), caseId: opts.caseId ?? null },
  )
  if (opts.cityClosed === false) {
    R.record.status = "resolved"
  } else {
    const row = await h.filings.insertMessageIfAbsent({
      filingId: F.id,
      inboundEmailId: randomUUID(),
      trusted: true,
    })
    await makeApplyCityUpdate({ ingest, reports: h.reports, notifications: h.notifier })({
      filingMessageId: row!.id,
      classification: { caseId: null, status: "closed", summary: "Closed", confidence: 0.9 },
    })
  }

  const reporterRepo = new InMemoryReportRepository(h.filings)
  reporterRepo.seedReport({
    id: R.record.id,
    reporterUserId: OWNER,
    status: R.record.status,
    category: "graffiti",
    type: "graffiti",
  })
  const warnings: unknown[][] = []
  const reporterService = makeReportService({
    repo: reporterRepo,
    resolveJurisdictionGeoid: () => Promise.resolve(null),
    presignMedia: (r2Key: string) => Promise.resolve({ url: `memory://${r2Key}` }),
    logger: { warn: (...args: unknown[]) => void warnings.push(args) },
  })
  const adminService = makeAdminReportService({
    repo: h.reports,
    outboundMail: {} as OutboundMailService,
    filings: memoryFilingService(h.reports, { filings: h.filings }),
    notifications: h.notifier,
  })

  const filingsOf = () => [...h.filings.filings.values()].filter((f) => f.reportId === R.record.id)
  const reopened = () => filingsOf().filter((f) => f.id !== F.id && f.status === "needs_human")

  return { h, R, F, reporterRepo, reporterService, adminService, warnings, filingsOf, reopened }
}

describe("D12 reopen", () => {
  it("T32: the reporter's reopen and an operator's resolved -> in_progress each create the reopen filing", async () => {
    const reporter = await world()
    expect(reporter.R.record.status).toBe("resolved")
    await reporter.reporterService.resolveReport(OWNER, reporter.R.record.id, false)
    expect(reporter.reopened()).toHaveLength(1)
    expect(reporter.reopened()[0]).toMatchObject({
      status: "needs_human",
      reason: "reopened_after_city_closed",
      reasonDetail: "Previous request had no number",
      channel: null,
      ticketText: reporter.F.ticketText,
    })

    const operator = await world()
    await operator.adminService.setStatus(operator.R.record.id, {
      status: "in_progress",
      actorId: OPERATOR,
    })
    expect(operator.reopened()).toHaveLength(1)
    expect(operator.reopened()[0]).toMatchObject({
      status: "needs_human",
      reason: "reopened_after_city_closed",
      reasonDetail: "Previous request had no number",
      channel: null,
    })
  })

  it("T33: with an active filing already open, neither path creates one: the reporter's logs one warn, the operator's audits reopenSkipped", async () => {
    const reporter = await world()
    await reporter.h.addFiling(reporter.R.record.id, { status: "queued", channel: "portal" })
    const before = reporter.filingsOf().length
    await reporter.reporterService.resolveReport(OWNER, reporter.R.record.id, false)
    expect(reporter.filingsOf()).toHaveLength(before)
    expect(reporter.warnings).toHaveLength(1)
    expect(JSON.stringify(reporter.warnings[0])).toContain(reporter.R.record.id)

    const operator = await world()
    await operator.h.addFiling(operator.R.record.id, { status: "queued", channel: "portal" })
    const count = operator.filingsOf().length
    await operator.adminService.setStatus(operator.R.record.id, {
      status: "in_progress",
      actorId: OPERATOR,
    })
    expect(operator.filingsOf()).toHaveLength(count)
    const audit = operator.h.reports.audits.find(
      (a) => a.action === "report.status_changed" && a.target === `report:${operator.R.record.id}`,
    )
    expect(audit?.meta).toMatchObject({ status: "in_progress", reopenSkipped: true })
  })

  it("T34: reopening a report the reporter resolved itself (no city_closed_at) creates no filing", async () => {
    const w = await world({ cityClosed: false })
    const before = w.filingsOf().length

    await w.reporterService.resolveReport(OWNER, w.R.record.id, false)

    expect(w.reporterRepo.reports.get(w.R.record.id)!.status).toBe("published")
    expect(w.filingsOf()).toHaveLength(before)
  })

  it("T45: the reporter's reopen of a report closed on request 1-111 names it in reasonDetail", async () => {
    const w = await world({ caseId: "1-111" })

    await w.reporterService.resolveReport(OWNER, w.R.record.id, false)

    expect(w.reopened().map((f) => f.reasonDetail)).toEqual(["Previous request 1-111"])
  })
})
