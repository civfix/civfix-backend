import type {
  JurisdictionDirectoryResponse,
  JurisdictionGeometryResponse,
  JurisdictionLayer,
  JurisdictionListQuery,
  ReportCategory,
} from "@civfix/shared"

/**
 * Sentinel geoid for the synthetic directory row that aggregates waiting reports with no jurisdiction or
 * an orphaned geoid. The directory is sourced from jurisdictions, so without it those reports would be
 * invisible. It is read-only triage: Save & route and PATCH 404 on it. The admin frontend keeps a matching
 * constant (discovery-page.tsx UNMAPPED_GEOID).
 */
export const UNMAPPED_GEOID = "__unmapped__"
export const UNMAPPED_NAME = "Unmapped / Unknown jurisdiction"

export interface JurisdictionDirectoryRecord {
  geoid: string
  name: string
  layer: JurisdictionLayer
  population: number | null
  /** Legacy contact_emails[]. */
  defaultEmails: string[]
  categoryContacts: { category: ReportCategory; email: string | null }[]
  hasDefaultContact: boolean
  reportFormUrl: string | null
  /** Open reports still waiting on a routing contact (un-routed, un-closed). */
  reportsWaiting: number
  perCategoryCounts: Partial<Record<ReportCategory, number>>
  /** Shares reportsWaiting's predicate. */
  oldestReportAt: Date | null
  lastRoutedAt: Date | null
  /** Takes precedence over verified/pending. */
  bounced: boolean
  contactUpdatedAt: Date | null
  flaggedAt: Date | null
  handle: string | null
  /** Null means the built-in default packet. */
  forwardSubjectTemplate: string | null
  forwardBodyTemplate: string | null
}

/**
 * "routed" = any contact on file (email or form); "none" = neither; "needs_mapping" = waiting reports and
 * no routing contact.
 */
export type DirectoryFilter = "all" | "email" | "form" | "none" | "routed" | "needs_mapping"

/** "oldest" ranks by each jurisdiction's oldest still-waiting report: the longest-unrouted backlog. */
export type DirectorySort = "population" | "reports" | "name" | "oldest"

export interface ListDirectoryArgs {
  q: string | null
  filter: DirectoryFilter
  layer: JurisdictionLayer | null
  sort: DirectorySort
  cursor: string | null
  limit: number
}

export interface ListDirectoryResult {
  records: JurisdictionDirectoryRecord[]
  nextCursor: string | null
  /** First page only. */
  total: number | null
  /** First page only. */
  facets: { routed: number; unrouted: number } | null
}

export interface JurisdictionGeometryRecord {
  geoid: string
  name: string
  layer: JurisdictionLayer
  bbox: [number, number, number, number]
  centroid: [number, number]
  geometry: { type: string; coordinates: unknown[] }
}

export interface SaveAndRouteResult {
  geoid: string
  taskResolved: boolean
  outreachEnqueued: boolean
}

export interface SaveContactsInput {
  contacts: Partial<Record<ReportCategory, string | null>>
  defaultEmails: string[]
  formUrl: string | null
  forwardSubjectTemplate?: string | null
  forwardBodyTemplate?: string | null
}

/**
 * Per-category contacts, the @handle and the forward templates clear on null/"". The legacy
 * `defaultEmails` and `formUrl` do not: the shared contacts upsert only writes a non-empty array and
 * COALESCEs the form URL, so `[]` / null mean "leave alone". Making them clearable is a wire-semantics
 * decision, since an operator form that always posts the field would otherwise wipe it.
 */
export interface PatchContactsInput {
  contacts?: Partial<Record<ReportCategory, string | null>>
  /** An empty array is "unchanged", not a clear. */
  defaultEmails?: string[]
  /** null/"" is "unchanged", not a clear. */
  formUrl?: string | null
  notes?: string | null
  flagged?: boolean
  flagReason?: string | null
  handle?: string | null
  forwardSubjectTemplate?: string | null
  forwardBodyTemplate?: string | null
}

export interface JurisdictionContactsRepository {
  jurisdictionExists(geoid: string): Promise<boolean>
  /**
   * One short transaction commits the contacts, the discovery task's resolution and the
   * discovery.contacts_saved audit row, so an audit failure rolls the save back. Saving a contact mails
   * nobody, so the geoid's waiting reports are left alone: flipping them to `acknowledged` would claim a
   * routing that never happened. Outreach is enqueued by the service after the commit.
   */
  saveAndRoute(
    geoid: string,
    input: SaveContactsInput,
    audit: { actorId: string | null },
  ): Promise<{ taskResolved: boolean }>
  /** Writes the jurisdiction.patched audit row in the same transaction. False for an unknown geoid. */
  patch(
    geoid: string,
    input: PatchContactsInput,
    audit: { actorId: string | null },
  ): Promise<boolean>
  getOutreachState(
    geoid: string,
  ): Promise<{ lastOutreachAt: Date | null; suppressed: boolean } | null>
  listDirectory(args: ListDirectoryArgs): Promise<ListDirectoryResult>
  getGeometry(geoid: string): Promise<JurisdictionGeometryRecord | null>
  // Bounce stamping is deliberately not on this seam: the module-level markBouncedContact in
  // jurisdiction-contacts-repository.drizzle.ts owns it, since it runs from the mail path with only a raw
  // Sql handle and also needs geoidForContact to re-open discovery.
}

export interface OutreachEnqueuer {
  enqueue(name: string, data: unknown, opts?: { singletonKey?: string }): Promise<string>
}

export interface JurisdictionContactsServiceDeps {
  repo: JurisdictionContactsRepository
  jobs: OutreachEnqueuer
  throttleDays: number
  outreachDigestEnabled: boolean
  now?: () => Date
}

/**
 * `actorId` is non-null because only operator-guarded routes call the mutations. The repository's audit
 * slot stays nullable: the outreach and autoforward jobs also drive its writes and have no operator.
 */
export interface JurisdictionContactsService {
  saveAndRoute(
    geoid: string,
    input: SaveContactsInput,
    actorId: string,
  ): Promise<SaveAndRouteResult>
  patch(geoid: string, input: PatchContactsInput, actorId: string): Promise<void>
  listDirectory(query: JurisdictionListQuery): Promise<JurisdictionDirectoryResponse>
  getGeometry(geoid: string): Promise<JurisdictionGeometryResponse>
}
