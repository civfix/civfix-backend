/**
 * Offline report-lookup test helper: an in-memory `DiscussionRepository` (the lean seam that survives the
 * removal of the per-report discussion system). It backs the report-chat routes' visibility + @city-forward
 * gating without a database (no Docker), faithful to the Drizzle impl's observable contract for the single
 * remaining method: findReportForDiscussion(reportId) resolves the report's visibility handle + its resolved
 * jurisdiction, or null when the report is unknown.
 */

import { randomUUID } from "node:crypto"
import type {
  DiscussionReportView,
  DiscussionRepository,
} from "../../src/services/discussion-repository.js"

/** A seeded jurisdiction (name/handle/contact resolved for a report). */
export interface SeededJurisdiction {
  geoid: string
  name: string
  handle: string | null
  contactEmail: string | null
}

export class InMemoryDiscussionRepository implements DiscussionRepository {
  /** Reports keyed by id (the visibility handle + resolved jurisdiction). */
  readonly reports = new Map<string, DiscussionReportView>()

  /** Seed a report's visibility handle + (optional) resolved jurisdiction. */
  seedReport(
    over: Partial<DiscussionReportView> & { id?: string; jurisdiction?: SeededJurisdiction | null },
  ): DiscussionReportView {
    const report: DiscussionReportView = {
      id: over.id ?? randomUUID(),
      reporterUserId: over.reporterUserId ?? null,
      status: over.status ?? "published",
      visibility: over.visibility ?? "public",
      deletedAt: over.deletedAt ?? null,
      jurisdiction: over.jurisdiction ?? null,
      category: over.category ?? "trash",
      place: over.place ?? "Somewhere, ST",
    }
    this.reports.set(report.id, report)
    return report
  }

  findReportForDiscussion(reportId: string): Promise<DiscussionReportView | null> {
    const r = this.reports.get(reportId)
    return Promise.resolve(r ? { ...r } : null)
  }
}
