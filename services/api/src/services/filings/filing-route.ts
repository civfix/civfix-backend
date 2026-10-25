import type { FilingRepository } from "./filing-repository.js"
import type { FilingChannel, FilingReason } from "./filing-types.js"

export interface FilingRouteSubject {
  /** The report's own jurisdiction; null outside every jurisdiction. */
  geoid: string | null
  category: string
  /** `getRouting`'s recipient choice for the report. */
  contact: string | null
}

export interface ResolvedFilingRoute {
  channel: FilingChannel | null
  /** The matched route's category: null for a jurisdiction default, an implicit route or no route. */
  routeCategory: string | null
  portalHost: string | null
  formUrl: string | null
  requestTypeHint: string | null
  includeLink: boolean
  /** Set for an email route, explicit or implicit. */
  recipient?: string | null
  /** Set when the filing can't go out by itself (D4). */
  reason?: FilingReason
}

export function resolveFilingRoute(
  _report: FilingRouteSubject,
  _deps: { filings: Pick<FilingRepository, "findRoutes"> },
): Promise<ResolvedFilingRoute> {
  throw new Error("not implemented")
}
