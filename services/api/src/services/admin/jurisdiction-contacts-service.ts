/**
 * Admin jurisdiction-contacts service (Phase 2): the "Save & route" core action + the jurisdictions
 * directory.
 *
 * "Save & route" is the heart of discovery: persisting a per-category routing contact for a GEOID
 * (a) upserts jurisdiction_contacts (per-category rows + a default/category-NULL row) and mirrors the
 * legacy jurisdictions.contact_emails[] / report_form_url, (b) sets jurisdictions.contact_updated_at,
 * (c) marks the geoid's open discovery task resolved (status 'done'), (d) ROUTES the pending pins -
 * every waiting report in the geoid is moved to 'acknowledged' with a routed timeline entry, so the
 * next pin (and the existing ones) now flow instead of waiting - and (e) enqueues throttled outreach
 * (the outreach.digest seam) so the outreach pipeline picks the jurisdiction up. See enumeration 2.B,
 * endpoints #13/#14/#15.
 *
 * REPOSITORY SEAM: every read/write goes through JurisdictionContactsRepository (Drizzle impl +
 * in-memory impl for the offline unit tests). The outreach enqueue is the injected Jobs seam (faked in
 * tests). Audit is the ROUTE's responsibility (it holds the operator userId); this service returns the
 * routing outcome so the route can audit + the test can assert.
 */

import { AppError } from "@civfix/shared"
import type {
  JurisdictionDirectoryDTO,
  JurisdictionLayer,
  JurisdictionListQuery,
  JurisdictionDirectoryResponse,
  ReportCategory,
} from "@civfix/shared"

/** The cron/queue job the outreach pipeline drains; enqueued (singletonKey=geoid) on save & route. */
export const OUTREACH_DIGEST_JOB = "outreach.digest"

/**
 * Sentinel geoid for the synthetic "Unmapped / Unknown jurisdiction" directory row. It aggregates every
 * WAITING report whose jurisdiction could not be resolved (jurisdiction_geoid IS NULL) OR whose geoid no
 * longer exists in the jurisdictions table (orphaned). Without this row those reports are invisible: the
 * directory is sourced FROM jurisdictions, so a report with no jurisdiction has no row to live under. The
 * row is read-only triage (it is NOT a real jurisdiction, so Save & route / PATCH 404 on it); the admin
 * special-cases this geoid to hide the routing controls and surface only the waiting backlog. The frontend
 * keeps a matching constant (discovery-page.tsx UNMAPPED_GEOID).
 */
export const UNMAPPED_GEOID = "__unmapped__"
/** Display name for the synthetic unmapped row. */
export const UNMAPPED_NAME = "Unmapped / Unknown jurisdiction"

// ---------------------------------------------------------------------------
// Repository seam
// ---------------------------------------------------------------------------

/** A directory row record (raw columns the repo derives; the service projects coverage/method labels). */
export interface JurisdictionDirectoryRecord {
  geoid: string
  name: string
  /** The jurisdiction layer/type (place|county|state|federal|tribal); drives the directory type chip. */
  layer: JurisdictionLayer
  /** TIGER/Census population (null when unknown); shown in the detail stats card. */
  population: number | null
  /** Legacy default contact emails (contact_emails[]); first is the directory's primary email. */
  defaultEmails: string[]
  /** Per-category contact emails on file (drives the coverage label + prefills the routing grid). */
  categoryContacts: { category: ReportCategory; email: string | null }[]
  /** Whether a default (category NULL) jurisdiction_contacts row exists. */
  hasDefaultContact: boolean
  reportFormUrl: string | null
  /** Total open reports in the geoid still waiting on a routing contact (un-routed, un-closed). */
  reportsWaiting: number
  /** Per-category breakdown of the waiting reports (only categories with >0 are present). */
  perCategoryCounts: Partial<Record<ReportCategory, number>>
  /** When a pin last routed to this jurisdiction's contact (null if never). */
  lastRoutedAt: Date | null
  /** Whether the contact has a recorded bounce (drives the 'bounced' status). */
  bounced: boolean
  /** contact_updated_at; a recently-saved contact is 'verified', an unsaved one 'pending'. */
  contactUpdatedAt: Date | null
  /** When an operator flagged this jurisdiction for review (null if not flagged). */
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
  /** Number of waiting reports that were routed (moved to acknowledged) by this save. */
  routedReports: number
  /** Whether an open discovery task for the geoid was marked resolved. */
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

export interface JurisdictionContactsRepository {
  /** Whether the jurisdiction exists (so the route can 404 an unknown geoid). */
  jurisdictionExists(geoid: string): Promise<boolean>
  /**
   * Persist contacts + route, atomically: upsert jurisdiction_contacts (+ legacy mirror), set
   * contact_updated_at, mark the open discovery task done, route every waiting report (-> acknowledged
   * + a routed timeline row), AND write the discovery.contacts_saved audit row - all in ONE transaction
   * (H4: "did + recorded" is atomic; an audit failure rolls the whole save back). Returns the routing
   * counts. Does NOT enqueue outreach (the service does, via Jobs, after the write commits); the outreach
   * outcome is not part of the atomic audit (the worker writes its own outreach.digest_sent audit).
   */
  saveAndRoute(
    geoid: string,
    input: SaveContactsInput,
    audit: { actorId: string | null },
  ): Promise<{ routedReports: number; taskResolved: boolean }>
  /**
   * Patch contacts/notes/form WITHOUT routing: upsert the provided contact fields, set notes when
   * provided, set contact_updated_at when any contact field changed, AND write the jurisdiction.patched
   * audit row - all in ONE transaction (H4). Returns false when the geoid is unknown.
   */
  patch(
    geoid: string,
    input: { contacts?: Partial<Record<ReportCategory, string | null>>; defaultEmails?: string[]; formUrl?: string | null; notes?: string | null; flagged?: boolean; flagReason?: string | null },
    audit: { actorId: string | null },
  ): Promise<boolean>
  /** Read the outreach throttle state for a geoid (last_outreach_at + suppressed), or null when absent. */
  getOutreachState(geoid: string): Promise<{ lastOutreachAt: Date | null; suppressed: boolean } | null>
  /** Page the directory rows (org/coverage/method derived by the service), filtered + searched. */
  listDirectory(args: ListDirectoryArgs): Promise<{ records: JurisdictionDirectoryRecord[]; nextCursor: string | null }>
}

// ---------------------------------------------------------------------------
// Pure helpers (no DB, no IO)
// ---------------------------------------------------------------------------

/** Human label per report category (kept local so the directory coverage label needs no cross-import). */
const CATEGORY_LABELS: Record<ReportCategory, string> = {
  trash: "Trash",
  recycling: "Recycling",
  graffiti: "Graffiti",
  hazard: "Hazard",
  water: "Water",
  other: "Other",
}

const ALL_CATEGORIES: readonly ReportCategory[] = [
  "trash",
  "recycling",
  "graffiti",
  "hazard",
  "water",
  "other",
]

/**
 * Derive the directory coverage label from the contact posture: "All categories" when a default contact
 * covers everything (or every category has a contact), the comma-joined category labels when only some
 * categories are covered, or "No routing" when nothing is on file.
 */
export function coverageLabel(record: JurisdictionDirectoryRecord): string {
  const covered = new Set(
    record.categoryContacts.filter((c) => c.email !== null && c.email.trim() !== "").map((c) => c.category),
  )
  const hasDefault = record.hasDefaultContact || record.defaultEmails.some((e) => e.trim() !== "")
  if (hasDefault || covered.size === ALL_CATEGORIES.length) return "All categories"
  if (covered.size === 0) return "No routing"
  return ALL_CATEGORIES.filter((c) => covered.has(c))
    .map((c) => CATEGORY_LABELS[c])
    .join(", ")
}

/** The directory routing method: an email contact, the city's form, or none yet. */
export function directoryMethod(record: JurisdictionDirectoryRecord): "email" | "form" | "none" {
  const hasEmail =
    record.defaultEmails.some((e) => e.trim() !== "") ||
    record.categoryContacts.some((c) => c.email !== null && c.email.trim() !== "")
  if (hasEmail) return "email"
  if (record.reportFormUrl !== null && record.reportFormUrl.trim() !== "") return "form"
  return "none"
}

/** The directory contact-health status: a bounced address, a saved (verified) contact, else pending. */
export function directoryStatus(
  record: JurisdictionDirectoryRecord,
): "verified" | "pending" | "bounced" {
  if (record.bounced) return "bounced"
  if (record.contactUpdatedAt !== null && directoryMethod(record) !== "none") return "verified"
  return "pending"
}

/** The primary directory email (first non-empty default, else the first category email, else null). */
export function primaryEmail(record: JurisdictionDirectoryRecord): string | null {
  const def = record.defaultEmails.find((e) => e.trim() !== "")
  if (def) return def
  const cat = record.categoryContacts.find((c) => c.email !== null && c.email.trim() !== "")
  return cat?.email ?? null
}

/** Whether at least one contact field is filled (the server-side "Save & route" precondition). */
export function hasAnyContact(input: SaveContactsInput): boolean {
  if (input.defaultEmails.some((e) => e.trim() !== "")) return true
  if (input.formUrl !== null && input.formUrl.trim() !== "") return true
  return Object.values(input.contacts).some((e) => e !== null && e !== undefined && e.trim() !== "")
}

/**
 * Build the synthetic "Unmapped / Unknown jurisdiction" directory record from the waiting-report totals
 * (see UNMAPPED_GEOID). `layer` is a placeholder ("place"); the admin special-cases UNMAPPED_GEOID and
 * never renders the type chip / routing controls for it. It always reads as method "none" (no contacts).
 */
export function buildUnmappedRecord(
  total: number,
  perCategoryCounts: Partial<Record<ReportCategory, number>>,
): JurisdictionDirectoryRecord {
  return {
    geoid: UNMAPPED_GEOID,
    name: UNMAPPED_NAME,
    layer: "place",
    population: null,
    defaultEmails: [],
    categoryContacts: [],
    hasDefaultContact: false,
    reportFormUrl: null,
    reportsWaiting: total,
    perCategoryCounts,
    lastRoutedAt: null,
    bounced: false,
    contactUpdatedAt: null,
    flaggedAt: null,
  }
}

/**
 * Whether the synthetic unmapped row should be included for these list args: only on the FIRST page (no
 * cursor), only under a facet a contact-less row matches (all | none — its method is "none"), and only
 * when a search term, if present, matches its name/geoid. The caller still suppresses it when its waiting
 * total is 0.
 */
export function shouldIncludeUnmapped(args: ListDirectoryArgs): boolean {
  if (args.cursor !== null) return false
  if (args.filter !== "all" && args.filter !== "none") return false
  if (args.q !== null) {
    const q = args.q.toLowerCase()
    return UNMAPPED_NAME.toLowerCase().includes(q) || UNMAPPED_GEOID.includes(q)
  }
  return true
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/** The Jobs seam slice the service needs (enqueue only); structurally compatible with the shared Jobs. */
export interface OutreachEnqueuer {
  enqueue(name: string, data: unknown, opts?: { singletonKey?: string }): Promise<string>
}

export interface JurisdictionContactsServiceDeps {
  repo: JurisdictionContactsRepository
  /** Jobs seam used to enqueue the outreach digest (faked in tests). */
  jobs: OutreachEnqueuer
  /** Outreach throttle window in days (env.OUTREACH_THROTTLE_DAYS); suppresses re-enqueue inside it. */
  throttleDays: number
  /** Injectable clock (defaults to Date.now) so the throttle window is deterministic in tests. */
  now?: () => Date
}

export interface JurisdictionContactsService {
  /** Save & route: persist contacts, route pending pins, enqueue throttled outreach. Audited in-tx (H4). */
  saveAndRoute(
    geoid: string,
    input: SaveContactsInput,
    actorId: string | null,
  ): Promise<SaveAndRouteResult>
  /** Patch a jurisdiction's contacts/notes/form WITHOUT routing. Audited in-tx (H4). */
  patch(
    geoid: string,
    input: { contacts?: Partial<Record<ReportCategory, string | null>>; defaultEmails?: string[]; formUrl?: string | null; notes?: string | null; flagged?: boolean; flagReason?: string | null },
    actorId: string | null,
  ): Promise<void>
  /** List the jurisdiction directory (org/dept/email/form/method/status/coverage/lastRouted). */
  listDirectory(query: JurisdictionListQuery): Promise<JurisdictionDirectoryResponse>
}

export function makeJurisdictionContactsService(
  deps: JurisdictionContactsServiceDeps,
): JurisdictionContactsService {
  const now = deps.now ?? (() => new Date())

  return {
    async saveAndRoute(
      geoid: string,
      input: SaveContactsInput,
      actorId: string | null,
    ): Promise<SaveAndRouteResult> {
      const exists = await deps.repo.jurisdictionExists(geoid)
      if (!exists) throw AppError.notFound("Jurisdiction not found")
      if (!hasAnyContact(input)) {
        throw AppError.validation({ contacts: "At least one contact is required to route." })
      }

      // The save + route + audit run atomically in the repo (H4); the audit records the routing effect
      // (the outreach enqueue is a post-commit action, audited separately by the worker on send).
      const { routedReports, taskResolved } = await deps.repo.saveAndRoute(geoid, input, { actorId })

      // Enqueue throttled outreach. The digest worker (mail/outreach wave) drains it; the throttle here
      // avoids re-enqueueing inside the window (the worker also enforces outreach_state, defense in depth).
      const outreachEnqueued = await maybeEnqueueOutreach(geoid)

      return { geoid, routedReports, taskResolved, outreachEnqueued }
    },

    async patch(
      geoid: string,
      input: {
        contacts?: Partial<Record<ReportCategory, string | null>>
        defaultEmails?: string[]
        formUrl?: string | null
        notes?: string | null
        flagged?: boolean
        flagReason?: string | null
      },
      actorId: string | null,
    ): Promise<void> {
      const ok = await deps.repo.patch(geoid, input, { actorId })
      if (!ok) throw AppError.notFound("Jurisdiction not found")
    },

    async listDirectory(query: JurisdictionListQuery): Promise<JurisdictionDirectoryResponse> {
      const args: ListDirectoryArgs = {
        q: query.q && query.q.trim() !== "" ? query.q.trim() : null,
        filter: (query.filter as ListDirectoryArgs["filter"]) ?? "all",
        cursor: query.cursor ?? null,
        limit: query.limit ?? 25,
      }
      const { records, nextCursor } = await deps.repo.listDirectory(args)
      const items = records.map(toDirectoryDTO)
      return { items, nextCursor }
    },
  }

  /** Enqueue the outreach digest unless suppressed or already enqueued inside the throttle window. */
  async function maybeEnqueueOutreach(geoid: string): Promise<boolean> {
    const state = await deps.repo.getOutreachState(geoid)
    if (state?.suppressed) return false
    if (state?.lastOutreachAt) {
      const windowMs = deps.throttleDays * 24 * 60 * 60 * 1000
      if (now().getTime() - state.lastOutreachAt.getTime() < windowMs) return false
    }
    await deps.jobs.enqueue(OUTREACH_DIGEST_JOB, { geoid }, { singletonKey: geoid })
    return true
  }
}

/** Project a directory record into the wire DTO (org/dept/email/form/method/status/coverage/lastRouted). */
export function toDirectoryDTO(record: JurisdictionDirectoryRecord): JurisdictionDirectoryDTO {
  return {
    geoid: record.geoid,
    org: record.name,
    // Department is not modeled separately in Phase 2; the directory shows the jurisdiction as the org.
    dept: null,
    email: primaryEmail(record),
    form: record.reportFormUrl,
    method: directoryMethod(record),
    status: directoryStatus(record),
    coverage: coverageLabel(record),
    lastRouted: record.lastRoutedAt !== null ? record.lastRoutedAt.toISOString() : null,
    layer: record.layer,
    population: record.population ?? 0,
    reportsWaiting: record.reportsWaiting,
    perCategoryCounts: record.perCategoryCounts,
    // The existing per-category contacts prefill the routing grid; drop empty-string emails to null so
    // they satisfy the DTO's email-or-null contract.
    contacts: record.categoryContacts.map((c) => ({
      category: c.category,
      email: c.email !== null && c.email.trim() !== "" ? c.email : null,
    })),
    flaggedAt: record.flaggedAt !== null ? record.flaggedAt.toISOString() : null,
  }
}
