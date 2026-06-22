import type {
  JurisdictionDirectoryResponse,
  JurisdictionLayer,
  JurisdictionListQuery,
  ReportCategory,
} from "@civfix/shared"

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
  lastRoutedAt: Date | null
  /** Whether the contact has a recorded bounce (takes precedence over verified/pending). */
  bounced: boolean
  contactUpdatedAt: Date | null
  flaggedAt: Date | null
}

/** Normalized directory list arguments (search + method facet + page window). */
export interface ListDirectoryArgs {
  q: string | null
  filter: "all" | "email" | "form" | "none"
  cursor: string | null
  limit: number
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
}

/** The optional-field contacts/notes/form/flag patch input (shared by the repo + service + route). */
export interface PatchContactsInput {
  contacts?: Partial<Record<ReportCategory, string | null>>
  defaultEmails?: string[]
  formUrl?: string | null
  notes?: string | null
  flagged?: boolean
  flagReason?: string | null
}

export interface JurisdictionContactsRepository {
  /** Whether the jurisdiction exists (so the route can 404 an unknown geoid). */
  jurisdictionExists(geoid: string): Promise<boolean>
  /**
   * Persist contacts + route, atomically: upsert jurisdiction_contacts (+ legacy mirror), set
   * contact_updated_at, mark the open discovery task done, route every waiting report (-> acknowledged
   * + a routed timeline row), AND write the discovery.contacts_saved audit row - all in ONE transaction
   * (H4: "did + recorded" is atomic; an audit failure rolls the whole save back). Does NOT enqueue
   * outreach (the service does, via Jobs, after the write commits).
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
  /** Page the directory rows (org/coverage/method derived by the service), filtered + searched. */
  listDirectory(args: ListDirectoryArgs): Promise<{ records: JurisdictionDirectoryRecord[]; nextCursor: string | null }>
  /**
   * Stamp `bounced_at = now()` on every jurisdiction_contacts row carrying this address: the inbound bounce
   * handler calls this when an outbound hard-bounces, so the directory surfaces a `bounced` contact (which
   * takes precedence over verified/pending) and re-opens discovery. A re-saved contact clears the marker.
   * No-op when the address matches no contact.
   */
  markContactBounced(email: string): Promise<void>
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

export interface JurisdictionContactsService {
  /** Save & route: persist contacts, route pending pins, enqueue throttled outreach. Audited in-tx (H4). */
  saveAndRoute(geoid: string, input: SaveContactsInput, actorId: string | null): Promise<SaveAndRouteResult>
  /** Patch a jurisdiction's contacts/notes/form WITHOUT routing. Audited in-tx (H4). */
  patch(geoid: string, input: PatchContactsInput, actorId: string | null): Promise<void>
  /** List the jurisdiction directory (org/dept/email/form/method/status/coverage/lastRouted). */
  listDirectory(query: JurisdictionListQuery): Promise<JurisdictionDirectoryResponse>
}
