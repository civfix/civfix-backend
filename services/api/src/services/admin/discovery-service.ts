// "Save & route", which persists contacts and routes pending pins, lives in
// jurisdiction-contacts-service.ts; this service backs the queue list, the detail and the note / flag /
// draft mutations.
//
// A report is "waiting on contact" for a geoid when it is non-deleted, still open (status NOT IN
// ('rejected','resolved')) and its jurisdiction has no usable routing contact.
//
// jurisdiction_discovery_tasks has no notes column, so operator notes are audit_log rows (action
// "discovery.note_added", target "discovery:<taskId>", meta.text + meta.who). That keeps them in the
// audited store the activity feed and audit view already read; see discovery-repository.drizzle.ts.

import { AppError, REPORT_CATEGORY_LABELS, relativeAgo } from "@civfix/shared"
import { ADMIN_CATEGORIES } from "./category-counts.js"
import type {
  DiscoveryContact,
  DiscoveryListQuery,
  DiscoveryListResponse,
  DiscoveryNote,
  DiscoverySamplePin,
  DiscoveryTaskDTO,
  DiscoveryTaskDetailDTO,
  JurisdictionLayer,
  PerCategoryCounts,
  Priority,
  ReportCategory,
} from "@civfix/shared"

/**
 * An alias, never a hand-copied list: a second list is how a new category silently drops out of the
 * per-category counts, the contact state and the dominant-category pin.
 */
const DISCOVERY_CATEGORIES = ADMIN_CATEGORIES

/** A task breaches when its oldest waiting report is older than this. */
export const DISCOVERY_SLA_HOURS = 24

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

export function fullPerCategoryCounts(
  partial: Partial<Record<ReportCategory, number>>,
): PerCategoryCounts {
  const out = {} as Record<ReportCategory, number>
  for (const category of DISCOVERY_CATEGORIES) {
    out[category] = partial[category] ?? 0
  }
  return out
}

/** Ties go to the canonical category order; "other" when nothing waits, so the row always has a pin. */
export function dominantCategory(partial: Partial<Record<ReportCategory, number>>): ReportCategory {
  let best: ReportCategory = "other"
  // Starting at 0 keeps an all-zero map on "other" rather than the first category.
  let bestCount = 0
  for (const category of DISCOVERY_CATEGORIES) {
    const count = partial[category] ?? 0
    if (count > bestCount) {
      best = category
      bestCount = count
    }
  }
  return best
}

/**
 * Categories with no waiting reports and no contact are neither routed nor missing: the attention
 * predicate is "some category has reports waiting but no contact".
 */
export function computeContactState(record: DiscoveryTaskRecord): {
  routed: ReportCategory[]
  missing: ReportCategory[]
} {
  const routedSet = new Set<ReportCategory>(record.contactCategories)
  const routed: ReportCategory[] = []
  const missing: ReportCategory[] = []
  for (const category of DISCOVERY_CATEGORIES) {
    const waiting = (record.perCategory[category] ?? 0) > 0
    const hasContact = routedSet.has(category) || record.hasDefaultContact
    if (hasContact) {
      if (waiting || routedSet.has(category)) routed.push(category)
    } else if (waiting) {
      missing.push(category)
    }
  }
  return { routed, missing }
}

export function isOverSla(oldestWaitingAt: Date | null, now: Date): boolean {
  if (oldestWaitingAt === null) return false
  const ageMs = now.getTime() - oldestWaitingAt.getTime()
  return ageMs > DISCOVERY_SLA_HOURS * 60 * 60 * 1000
}

/**
 * The row's `priority` is an urgency band, not the jurisdictions.priority layer ordinal
 * (place<county<state), so it is computed from the queue signals rather than read from that column.
 */
export function derivePriority(record: DiscoveryTaskRecord, now: Date): Priority {
  if (isOverSla(record.oldestWaitingAt, now)) return "high"
  if (record.total > 0) return "med"
  return "low"
}

export function suggestionToNote(s: DiscoveryContactSuggestionRecord): DiscoveryNoteRecord {
  const contact = [s.email, s.formUrl]
    .filter((v): v is string => !!v && v.trim() !== "")
    .join(" / ")
  const head = `Suggested contact: ${contact || "(none provided)"}`
  return {
    who: "Reporter",
    text: s.note && s.note.trim() !== "" ? `${head} (note: ${s.note.trim()})` : head,
    createdAt: s.createdAt,
  }
}

export interface DiscoveryServiceDeps {
  repo: DiscoveryRepository
  now?: () => Date
}

export interface DiscoveryService {
  list(query: DiscoveryListQuery): Promise<DiscoveryListResponse>
  getTask(id: string): Promise<DiscoveryTaskDetailDTO>
  addNote(id: string, input: { text: string; actorId: string; who: string }): Promise<DiscoveryNote>
  flag(id: string, input: { reason: string | null; actorId: string }): Promise<void>
  saveDraft(
    id: string,
    input: {
      contacts: Partial<Record<ReportCategory, string | null>>
      defaultEmails: string[]
      formUrl: string | null
      actorId: string
    },
  ): Promise<void>
}

export function makeDiscoveryService(deps: DiscoveryServiceDeps): DiscoveryService {
  const now = deps.now ?? (() => new Date())

  function toNoteDTO(record: DiscoveryNoteRecord, ref: Date): DiscoveryNote {
    return { text: record.text, who: record.who, when: relativeAgo(record.createdAt, ref) }
  }

  function toTaskDTO(
    record: DiscoveryTaskRecord,
    notes: DiscoveryNoteRecord[],
    ref: Date,
  ): DiscoveryTaskDTO {
    const category = dominantCategory(record.perCategory)
    return {
      id: record.id,
      geoid: record.geoid,
      place: record.place,
      layer: record.layer,
      category,
      catLabel: REPORT_CATEGORY_LABELS[category],
      pop: record.population ?? 0,
      reports: record.total,
      perCategoryCounts: fullPerCategoryCounts(record.perCategory),
      lastReport: record.newestWaitingAt !== null ? relativeAgo(record.newestWaitingAt, ref) : "-",
      age: record.oldestWaitingAt !== null ? relativeAgo(record.oldestWaitingAt, ref) : "-",
      overSla: isOverSla(record.oldestWaitingAt, ref),
      priority: derivePriority(record, ref),
      contactState: computeContactState(record),
      notes: notes.map((n) => toNoteDTO(n, ref)),
    }
  }

  return {
    async list(query: DiscoveryListQuery): Promise<DiscoveryListResponse> {
      const ref = now()
      const args: ListDiscoveryArgs = {
        q: query.q && query.q.trim() !== "" ? query.q.trim() : null,
        filter: query.filter ?? "all",
        sort: query.sort ?? "pop",
        cursor: query.cursor ?? null,
        limit: query.limit ?? 25,
      }
      const { records, nextCursor } = await deps.repo.listTasks(args)
      // Only the detail renders notes, so list rows carry an empty notes[] rather than a note read
      // per task.
      const items = records.map((record) => toTaskDTO(record, [], ref))
      return { items, nextCursor }
    },

    async getTask(id: string): Promise<DiscoveryTaskDetailDTO> {
      const ref = now()
      const [detail, notes] = await Promise.all([deps.repo.getDetail(id), deps.repo.listNotes(id)])
      if (!detail) throw AppError.notFound("Discovery task not found")

      const suggestions = await deps.repo.listContactSuggestions(detail.task.geoid)
      const merged = [...notes, ...suggestions.map(suggestionToNote)].sort(
        (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
      )

      const base = toTaskDTO(detail.task, merged, ref)
      const contacts: DiscoveryContact[] = detail.contacts.map((c) => ({
        category: c.category,
        email: c.email,
      }))
      const samplePins: DiscoverySamplePin[] = detail.samplePins.map((p) => ({
        category: p.category,
        lat: p.lat,
        lng: p.lng,
        // Pins are real waiting reports, never operator-drafted markers.
        draft: false,
      }))
      return {
        ...base,
        contacts,
        placeGeojson: detail.placeGeojson ?? null,
        samplePins,
        center: detail.center,
        zoom: detail.zoom,
      }
    },

    async addNote(
      id: string,
      input: { text: string; actorId: string; who: string },
    ): Promise<DiscoveryNote> {
      const ref = now()
      const task = await deps.repo.getTask(id)
      if (!task) throw AppError.notFound("Discovery task not found")
      const note = await deps.repo.addNote(id, input)
      return toNoteDTO(note, ref)
    },

    async flag(id: string, input: { reason: string | null; actorId: string }): Promise<void> {
      const ok = await deps.repo.flagTask(id, input)
      if (!ok) throw AppError.notFound("Discovery task not found")
    },

    async saveDraft(
      id: string,
      input: {
        contacts: Partial<Record<ReportCategory, string | null>>
        defaultEmails: string[]
        formUrl: string | null
        actorId: string
      },
    ): Promise<void> {
      const ok = await deps.repo.saveDraft(id, input)
      if (!ok) throw AppError.notFound("Discovery task not found")
    },
  }
}
