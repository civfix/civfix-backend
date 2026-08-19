import type {
  JurisdictionDirectoryResponse,
  JurisdictionGeometryResponse,
  JurisdictionLayer,
  JurisdictionListQuery,
  ReportCategory,
} from "@civfix/shared"

/**
 * The pg-boss queue the outreach digest runs on: enqueued here by save-and-route and scheduled/worked by
 * registerOutreachJobs (which re-exports this constant). Declared in this zero-runtime module so both sides
 * share ONE literal without the service importing the job registration.
 */
export const OUTREACH_DIGEST_JOB = "outreach.digest"

/**
 * Sentinel geoid for the synthetic "Unmapped / Unknown jurisdiction" directory row. It aggregates every
 * WAITING report whose jurisdiction could not be resolved (jurisdiction_geoid IS NULL) OR whose geoid no
 * longer exists in the jurisdictions table (orphaned). Without this row those reports are invisible: the
 * directory is sourced FROM jurisdictions, so a report with no jurisdiction has no row to live under. The
 * row is read-only triage (it is NOT a real jurisdiction, so Save & route / PATCH 404 on it). The frontend
 * keeps a matching constant (discovery-page.tsx UNMAPPED_GEOID).
 */
export const UNMAPPED_GEOID = "__unmapped__"
export const UNMAPPED_NAME = "Unmapped / Unknown jurisdiction"

/** A directory row record (raw columns the repo derives; the service projects coverage/method labels). */
export interface JurisdictionDirectoryRecord {
  geoid: string
  name: string
  layer: JurisdictionLayer
  population: number | null
  /** Legacy default contact emails (contact_emails[]); first is the directory's primary email. */
  defaultEmails: string[]
  categoryContacts: { category: ReportCategory; email: string | null }[]
  hasDefaultContact: boolean
  reportFormUrl: string | null
  /** Total open reports in the geoid still waiting on a routing contact (un-routed, un-closed). */
  reportsWaiting: number
  perCategoryCounts: Partial<Record<ReportCategory, number>>
  /** The oldest still-waiting report's created_at (agrees with reportsWaiting's predicate), or null. */
  oldestReportAt: Date | null
  lastRoutedAt: Date | null
  /** Whether the contact has a recorded bounce (takes precedence over verified/pending). */
  bounced: boolean
  contactUpdatedAt: Date | null
  flaggedAt: Date | null
  /** The discussion @handle (the "@sf" mentionable in a report discussion), or null when unset. */
  handle: string | null
  /** Custom forwarding email templates (null = use the built-in default packet). Prefill the editor. */
  forwardSubjectTemplate: string | null
  forwardBodyTemplate: string | null
}

/**
 * Directory routing-posture facet. "routed" = any contact on file (email OR form); "none" = neither.
 * "needs_mapping" = has WAITING reports AND no routing contact (the actionable backlog to map).
 */
export type DirectoryFilter = "all" | "email" | "form" | "none" | "routed" | "needs_mapping"

/**
 * Directory sort key. "population" (default) and "reports" are DESC; "name" is A->Z; "oldest" surfaces the
 * jurisdiction whose oldest still-waiting report is oldest first (the longest-unrouted backlog).
 */
export type DirectorySort = "population" | "reports" | "name" | "oldest"

/** Normalized directory list arguments (search + method facet + type filter + sort + page window). */
export interface ListDirectoryArgs {
  q: string | null
  filter: DirectoryFilter
  /** Narrow to one jurisdiction TYPE (state/county/place/federal/tribal), or null for every type. */
  layer: JurisdictionLayer | null
  sort: DirectorySort
  cursor: string | null
  limit: number
}

/** The directory page plus the first-page-only totals (active-filter count + search/type chip facets). */
export interface ListDirectoryResult {
  records: JurisdictionDirectoryRecord[]
  nextCursor: string | null
  /** Count of jurisdictions matching the search, type, and active filter; only on the first page. */
  total: number | null
  /** Routed/unrouted split of the search result; only computed on the first page. */
  facets: { routed: number; unrouted: number } | null
}

/** One jurisdiction's boundary geometry for the verification map (simplified GeoJSON + bbox + interior point). */
export interface JurisdictionGeometryRecord {
  geoid: string
  name: string
  layer: JurisdictionLayer
  bbox: [number, number, number, number]
  centroid: [number, number]
  geometry: { type: string; coordinates: unknown[] }
}

/** The outcome of a save-and-route, returned for the route to audit + the test to assert. */
export interface SaveAndRouteResult {
  geoid: string
  routedReports: number
  taskResolved: boolean
  /** Whether outreach was enqueued (false when throttled/suppressed). */
  outreachEnqueued: boolean
}

/** The contact-save input shared by save-and-route and the patch path. */
export interface SaveContactsInput {
  contacts: Partial<Record<ReportCategory, string | null>>
  defaultEmails: string[]
  formUrl: string | null
  forwardSubjectTemplate?: string | null
  forwardBodyTemplate?: string | null
}

/**
 * The optional-field contacts/notes/form/flag patch input (shared by the repo + service + route).
 *
 * CLEARING: per-category contacts, the @handle and the forward templates all clear on null/"". The legacy
 * `defaultEmails` and `formUrl` do NOT: the shared contacts upsert only ever writes a non-empty array and
 * COALESCEs the form URL, so `[]` / null read as "leave alone" rather than "clear". Both repository
 * bindings behave the same way, so it is consistent — just asymmetric, and clearing a stale legacy email or
 * form URL is a wire-semantics decision (an operator form that always posts the field would otherwise wipe
 * it) plus a change to upsertJurisdictionContacts.
 */
export interface PatchContactsInput {
  contacts?: Partial<Record<ReportCategory, string | null>>
  /** Legacy default emails. An empty array is "unchanged", NOT a clear (see the interface note). */
  defaultEmails?: string[]
  /** Report form URL. null/"" is "unchanged", NOT a clear (see the interface note). */
  formUrl?: string | null
  notes?: string | null
  flagged?: boolean
  flagReason?: string | null
  /** Set / clear the discussion @handle (normalized + shape-checked by the shared schema; null/"" clears). */
  handle?: string | null
  /** Set / clear the custom forwarding subject template (bounded by the shared schema; null/"" clears). */
  forwardSubjectTemplate?: string | null
  /** Set / clear the custom forwarding body template (bounded by the shared schema; null/"" clears). */
  forwardBodyTemplate?: string | null
}

export interface JurisdictionContactsRepository {
  /** Whether the jurisdiction exists (so the route can 404 an unknown geoid). */
  jurisdictionExists(geoid: string): Promise<boolean>
  /**
   * Persist contacts + route. ONE short transaction commits the operator's input: upsert
   * jurisdiction_contacts (+ legacy mirror), set contact_updated_at, mark the open discovery task done,
   * route the FIRST bounded batch of waiting reports (-> acknowledged + a routed timeline row), AND
   * write the discovery.contacts_saved audit row (H4: "did + recorded" is atomic; an audit failure rolls
   * the save back). Routing the rest of the backlog is deliberately OUTSIDE that transaction, in bounded
   * batches committed one at a time (F094): an unbounded UPDATE over every waiting report of a large
   * jurisdiction blew the 15s statement_timeout and rolled the operator's contacts back, and held row
   * locks on the whole backlog meanwhile. Each batch commits on its own, so a timeout or a dropped
   * connection loses only the un-drained tail - re-saving resumes it. Does NOT enqueue outreach (the
   * service does, via Jobs, after the write commits).
   */
  saveAndRoute(
    geoid: string,
    input: SaveContactsInput,
    audit: { actorId: string | null },
  ): Promise<{ routedReports: number; taskResolved: boolean }>
  /**
   * Patch contacts/notes/form WITHOUT routing, AND write the jurisdiction.patched audit row, all in ONE
   * transaction (H4). Returns false when the geoid is unknown.
   */
  patch(geoid: string, input: PatchContactsInput, audit: { actorId: string | null }): Promise<boolean>
  /** Read the outreach throttle state for a geoid (last_outreach_at + suppressed), or null when absent. */
  getOutreachState(geoid: string): Promise<{ lastOutreachAt: Date | null; suppressed: boolean } | null>
  /** Page the directory rows (org/coverage/method derived by the service), searched + filtered + sorted. */
  listDirectory(args: ListDirectoryArgs): Promise<ListDirectoryResult>
  /** One jurisdiction's simplified boundary geometry for the map, or null when it has no stored boundary. */
  getGeometry(geoid: string): Promise<JurisdictionGeometryRecord | null>
  // NOTE: bounce stamping is NOT on this seam. The inbound bounce handler owns it end to end
  // (inbound-bounce.ts markBouncedContact), because it runs from the mail path with only a raw Sql handle
  // and also needs geoidForContact to re-open discovery. A parallel repo method existed here with zero
  // callers and a duplicate UPDATE; it was removed rather than left to drift.
}

/** The Jobs seam slice the service needs (enqueue only); structurally compatible with the shared Jobs. */
export interface OutreachEnqueuer {
  enqueue(name: string, data: unknown, opts?: { singletonKey?: string }): Promise<string>
}

export interface JurisdictionContactsServiceDeps {
  repo: JurisdictionContactsRepository
  jobs: OutreachEnqueuer
  /** Outreach throttle window in days (env.OUTREACH_THROTTLE_DAYS); suppresses re-enqueue inside it. */
  throttleDays: number
  /** Injectable clock (defaults to Date.now) so the throttle window is deterministic in tests. */
  now?: () => Date
}

/**
 * `actorId` is NON-NULL on both mutating methods: the only callers are the operator-guarded jurisdiction
 * routes, where `requireOperator(request)` returns a `string` or throws, so an unattributed audit row for
 * a "Save & route" is not a reachable state. The REPOSITORY audit slot above stays nullable — its writes
 * are also driven by the system-owned outreach/autoforward jobs, which genuinely have no operator.
 */
export interface JurisdictionContactsService {
  /** Save & route: persist contacts, route pending pins, enqueue throttled outreach. Audited in-tx (H4). */
  saveAndRoute(geoid: string, input: SaveContactsInput, actorId: string): Promise<SaveAndRouteResult>
  /** Patch a jurisdiction's contacts/notes/form WITHOUT routing. Audited in-tx (H4). */
  patch(geoid: string, input: PatchContactsInput, actorId: string): Promise<void>
  /** List the jurisdiction directory (org/dept/email/form/method/status/coverage/lastRouted). */
  listDirectory(query: JurisdictionListQuery): Promise<JurisdictionDirectoryResponse>
  /** One jurisdiction's boundary geometry for the verification map; 404s when the geoid has no boundary. */
  getGeometry(geoid: string): Promise<JurisdictionGeometryResponse>
}
