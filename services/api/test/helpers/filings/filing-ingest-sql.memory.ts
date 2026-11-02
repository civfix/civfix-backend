import { ACTIVE_FILING_STATUSES } from "../../../src/services/filings/filing-types.js"
import type {
  ApplyCityUpdateInput,
  ApplyCityUpdateResult,
  CityUpdateEffect,
  CityUpdateFiling,
  FilingIngestSql,
} from "../../../src/services/filings/filing-ingest-sql.drizzle.js"
import type { InMemoryAdminReportRepository } from "../admin/admin-report-repository.memory.js"
import type { InMemoryFilingRepository } from "./filing-repository.memory.js"

/**
 * The ingest queries' twin over the filing and admin report twins. The claim is taken synchronously
 * before any await, as the row lock of the real transaction, so concurrent updates apply once.
 */
export class InMemoryFilingIngestSql implements FilingIngestSql {
  constructor(
    readonly filings: InMemoryFilingRepository,
    readonly reports: InMemoryAdminReportRepository,
  ) {}

  reportIdByReferenceCode(code: string): Promise<string | null> {
    const found = [...this.reports.reports.values()].find((r) => r.record.referenceCode === code)
    return Promise.resolve(found?.record.id ?? null)
  }

  applyCityUpdate(input: ApplyCityUpdateInput): Promise<ApplyCityUpdateResult> {
    const message = this.filings.messages.find((m) => m.id === input.messageId)
    if (
      message === undefined ||
      !message.trusted ||
      message.flagged ||
      message.appliedAt !== null
    ) {
      return Promise.resolve({ claimed: false })
    }
    message.appliedAt = new Date()
    message.classification = input.classification
    message.summary = input.classification?.summary ?? null
    const stored = this.filings.filings.get(message.filingId)
    if (stored === undefined)
      return Promise.reject(new Error("filing_messages row names no filing"))
    const filing: CityUpdateFiling = {
      id: stored.id,
      reportId: stored.reportId,
      channel: stored.channel,
      status: stored.status,
      caseId: stored.caseId,
      jurisdictionName:
        stored.geoid === null ? null : (this.filings.jurisdictions.get(stored.geoid) ?? null),
    }
    const effect = input.plan(filing)
    const applied = this.apply(filing, effect)
    if (effect.kind === "flag" || (effect.kind !== "none" && !applied)) message.flagged = true
    return Promise.resolve({ claimed: true, filing, effect, applied })
  }

  private apply(filing: CityUpdateFiling, effect: CityUpdateEffect): boolean {
    const stored = this.filings.filings.get(filing.id)!
    const seeded = this.reports.reports.get(filing.reportId)
    const now = new Date()
    switch (effect.kind) {
      case "none":
      case "flag":
        return false
      case "case_id":
        if (stored.caseId !== null) return false
        this.filings.filings.set(stored.id, { ...stored, caseId: effect.caseId, updatedAt: now })
        if (seeded !== undefined) {
          this.timeline(filing.reportId).push({
            status: seeded.record.status,
            note: effect.note,
            kind: "reply",
            who: "system",
            createdAt: now,
          })
        }
        return true
      case "report_status":
        if (
          seeded === undefined ||
          seeded.deletedAt !== null ||
          !effect.from.includes(seeded.record.status)
        ) {
          return false
        }
        seeded.record.status = effect.to
        this.timeline(filing.reportId).push({
          status: effect.to,
          note: effect.note,
          kind: effect.timelineKind ?? null,
          who: "system",
          createdAt: now,
        })
        if (effect.cityClosed) {
          this.filings.filings.set(stored.id, { ...stored, cityClosedAt: now, updatedAt: now })
        }
        return true
      case "needs_info": {
        const activeElsewhere = [...this.filings.filings.values()].some(
          (f) => f.reportId === stored.reportId && ACTIVE_FILING_STATUSES.includes(f.status),
        )
        if (!["submitted", "linked_existing"].includes(stored.status) || activeElsewhere) {
          return false
        }
        this.filings.filings.set(stored.id, {
          ...stored,
          status: "needs_human",
          reason: "city_needs_info",
          reasonDetail: effect.reasonDetail,
          updatedAt: now,
        })
        return true
      }
    }
  }

  private timeline(reportId: string) {
    const list = this.reports.timeline.get(reportId) ?? []
    this.reports.timeline.set(reportId, list)
    return list
  }
}
