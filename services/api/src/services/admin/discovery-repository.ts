import type { JurisdictionLayer, ReportCategory } from "@civfix/shared"

export interface DiscoveryTaskRecord {
  id: string
  geoid: string
  place: string
  layer: JurisdictionLayer
  population: number | null
  status: string
  perCategory: Partial<Record<ReportCategory, number>>
  total: number
  oldestWaitingAt: Date | null
  newestWaitingAt: Date | null
  contactCategories: ReportCategory[]
  hasDefaultContact: boolean
}

/** A null email means the contact row is on file but blank. */
export interface DiscoveryContactRecord {
  category: ReportCategory
  email: string | null
}

export interface DiscoverySamplePinRecord {
  category: ReportCategory
  lat: number
  lng: number
}

export interface DiscoveryNoteRecord {
  text: string
  who: string
  createdAt: Date
}

/** Stored as an audit_log `discovery.contact_suggested` row by the public suggest-contact endpoint. */
export interface DiscoveryContactSuggestionRecord {
  email: string | null
  formUrl: string | null
  note: string | null
  createdAt: Date
}

export interface DiscoveryDetailRecord {
  task: DiscoveryTaskRecord
  contacts: DiscoveryContactRecord[]
  placeGeojson: unknown | null
  samplePins: DiscoverySamplePinRecord[]
  center: [number, number] | null
  zoom: number | null
}

export type DiscoveryFilter = "all" | "attention" | "clear"

export type DiscoverySort = "pop" | "reports"

export interface ListDiscoveryArgs {
  q: string | null
  filter: DiscoveryFilter
  sort: DiscoverySort
  cursor: string | null
  limit: number
}

export interface DiscoveryRepository {
  /** The repository owns the filter and sort semantics so the service stays a pure projector. */
  listTasks(
    args: ListDiscoveryArgs,
  ): Promise<{ records: DiscoveryTaskRecord[]; nextCursor: string | null }>
  getDetail(id: string): Promise<DiscoveryDetailRecord | null>
  /** Oldest first. */
  listNotes(id: string): Promise<DiscoveryNoteRecord[]>
  /** Oldest first. */
  listContactSuggestions(geoid: string): Promise<DiscoveryContactSuggestionRecord[]>
  getTask(id: string): Promise<DiscoveryTaskRecord | null>
  addNote(
    id: string,
    input: { text: string; actorId: string | null; who: string },
  ): Promise<DiscoveryNoteRecord>
  /**
   * Opens an abuse_flag against the task's sample report when one is on file and marks the task
   * in_progress. False when the task does not exist.
   */
  flagTask(id: string, input: { reason: string | null; actorId: string | null }): Promise<boolean>
  /**
   * Upserts contacts and the form URL without routing: contact_updated_at, pending pins and outreach are
   * left alone. False when the task does not exist.
   */
  saveDraft(
    id: string,
    input: {
      contacts: Partial<Record<ReportCategory, string | null>>
      defaultEmails: string[]
      formUrl: string | null
      actorId: string | null
    },
  ): Promise<boolean>
  /**
   * Idempotent: at most one open task per geoid (ON CONFLICT (geoid) WHERE status <> 'done' DO NOTHING).
   * False when an open task already existed or the jurisdiction is unknown.
   */
  materializeDiscoveryTask(input: { geoid: string; population?: number | null }): Promise<boolean>
}
