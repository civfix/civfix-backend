import {
  reopenReasonDetail,
  type ReopenFilingOutcome,
} from "../../../src/services/filings/filing-reopen.drizzle.js"
import type { InMemoryFilingRepository } from "./filing-repository.memory.js"

/** `insertReopenFilingIn`'s twin, for the report twins' status changes away from `resolved`. */
export async function insertReopenFilingInMemory(
  filings: InMemoryFilingRepository,
  reportId: string,
): Promise<ReopenFilingOutcome> {
  const closed = await filings.getLatestSuccessfulForReport(reportId)
  if (closed === null || closed.cityClosedAt === null) return "none"
  const created = await filings.create({
    reportId,
    geoid: closed.geoid,
    category: closed.category,
    status: "needs_human",
    reason: "reopened_after_city_closed",
    reasonDetail: reopenReasonDetail(closed.caseId),
    ticketText: closed.ticketText,
  })
  return created.kind === "created" ? "created" : "skipped_active"
}
