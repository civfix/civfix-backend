import type { FilingRepository } from "./filing-repository.js"
import type { FilingChannel, FilingReason, FilingRouteRecord } from "./filing-types.js"

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

const NO_ROUTE: ResolvedFilingRoute = {
  channel: null,
  routeCategory: null,
  portalHost: null,
  formUrl: null,
  requestTypeHint: null,
  includeLink: true,
  reason: "no_route",
}

/** The portal key: the lowercase hostname of the route's start URL (D4). */
export function portalHostOf(formUrl: string): string {
  return new URL(formUrl).hostname.toLowerCase()
}

function fromRoute(route: FilingRouteRecord, contact: string | null): ResolvedFilingRoute {
  return {
    channel: route.channel,
    routeCategory: route.category,
    portalHost:
      route.channel === "portal" && route.formUrl !== null ? portalHostOf(route.formUrl) : null,
    formUrl: route.formUrl,
    requestTypeHint: route.requestTypeHint,
    includeLink: route.includeLink,
    ...(route.channel === "email" ? { recipient: contact } : {}),
  }
}

/**
 * D4's resolution, stopping at the first match: the (geoid, category) route, the (geoid, NULL) default,
 * then an implicit email route when `getRouting` found a contact. A matched route that is disabled or
 * manual still names its channel, so the admin can show where the report would go.
 */
export async function resolveFilingRoute(
  report: FilingRouteSubject,
  deps: { filings: Pick<FilingRepository, "findRoutes"> },
): Promise<ResolvedFilingRoute> {
  if (report.geoid === null) return NO_ROUTE
  const routes = await deps.filings.findRoutes(report.geoid, report.category)
  const matched =
    routes.find((r) => r.category === report.category) ?? routes.find((r) => r.category === null)
  if (matched === undefined) {
    if (report.contact === null || report.contact === "") return NO_ROUTE
    return {
      channel: "email",
      routeCategory: null,
      portalHost: null,
      formUrl: null,
      requestTypeHint: null,
      includeLink: true,
      recipient: report.contact,
    }
  }
  const resolved = fromRoute(matched, report.contact)
  if (!matched.enabled) return { ...resolved, reason: "route_disabled" }
  if (matched.channel === "manual") return { ...resolved, reason: "manual_route" }
  return resolved
}
