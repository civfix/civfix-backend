/**
 * Admin discovery service (Phase 2): the "Jurisdictions" onboarding queue.
 *
 * Pins land in places civfix has no routing contact for yet. The operator researches the jurisdiction
 * (by GEOID), saves a per-category routing contact, and reports start flowing. This service backs the
 * list (population-sorted), the detail (per-category waiting counts + existing contacts + mini-map
 * pins), and the note / flag / draft mutations. The "Save & route" action that actually persists
 * contacts + routes pending pins lives in jurisdiction-contacts-service.ts (it shares the same repo
 * concern of writing jurisdiction_contacts). See enumeration 2.B + endpoints #8-#12.
 *
 * REPOSITORY SEAM: every read/write goes through DiscoveryRepository (Drizzle impl in
 * discovery-repository.drizzle.ts; an in-memory impl in discovery-repository.memory.ts for the offline
 * unit tests), mirroring the Phase 1 report-service/report-repository split so the service is testable
 * with no database and no Docker.
 *
 * WAITING-REPORT MODEL: a report counts as "waiting on contact" for a geoid when it is non-deleted and
 * still open (status NOT IN ('rejected','resolved')) AND its jurisdiction has no usable routing contact.
 * The same notion drives the discovery queue (a task is "needs attention" when it has waiting reports
 * but a category is missing a contact). The repo computes the per-category waiting counts; this service
 * projects them into the DTO shape + computes the relative-age / SLA labels (pure, clock-injected).
 *
 * NOTES STORAGE: jurisdiction_discovery_tasks has no notes column and the foundation schema is frozen
 * (decisions: do NOT add a column). Operator notes are therefore persisted as audit_log rows with
 * action "discovery.note_added" (target = "discovery:<taskId>", meta.text + meta.who) and read back from
 * audit_log into the notes[] list. This keeps notes in the same audited store the activity feed + audit
 * view already read, with no schema change. See discovery-repository.drizzle.ts addNote/listNotes.
 */

import { AppError, relativeAgo } from "@civfix/shared"
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

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * The 6 canonical civfix report categories in display order (matches ReportCategorySchema / the DB
 * REPORT_CATEGORY_VALUES). Declared locally because @civfix/shared exports the zod enum + the inferred
 * type but not a plain array constant, and the discovery projections iterate the categories directly.
 */
export const DISCOVERY_CATEGORIES: readonly ReportCategory[] = [
  "trash",
  "recycling",
  "graffiti",
  "hazard",
  "water",
  "other",
]

/** Discovery SLA: a task breaches when its oldest waiting report is older than this many hours. */
export const DISCOVERY_SLA_HOURS = 24

/** Human label per report category (drives catLabel + the dominant-category pin title). */
export const CATEGORY_LABELS: Record<ReportCategory, string> = {
  trash: "Trash",
  recycling: "Recycling",
  graffiti: "Graffiti",
  hazard: "Hazard",
  water: "Water",
  other: "Other",
}

// ---------------------------------------------------------------------------
// Repository seam (structural records; faked in tests)
// ---------------------------------------------------------------------------

/**
 * A discovery task row joined with its jurisdiction, plus the derived waiting-report aggregates the
 * queue needs. `perCategory` is the count of waiting reports per category for the geoid; `total` is
 * their sum. `oldestWaitingAt` / `newestWaitingAt` are the oldest + newest waiting-report timestamps
 * (null when there are none). `contactCategories` is the set of categories that have a routing contact
 * (a category-specific jurisdiction_contacts row, OR any default/legacy contact when at least one
 * default exists), used to compute the routed/missing contact state.
 */
export interface DiscoveryTaskRecord {
  id: string
  geoid: string
  place: string
  /** The jurisdiction layer/type (place|county|state|federal|tribal); drives the queue row type chip. */
  layer: JurisdictionLayer
  population: number | null
  status: string
  perCategory: Partial<Record<ReportCategory, number>>
  total: number
  oldestWaitingAt: Date | null
  newestWaitingAt: Date | null
  /** Categories with a usable routing contact (per-category override OR a present default/legacy). */
  contactCategories: ReportCategory[]
  /** Whether a default/all-categories or legacy contact is on file (drives the "all routed" fallback). */
  hasDefaultContact: boolean
}

/** An existing per-category routing contact (one email per category; null email = on file but blank). */
export interface DiscoveryContactRecord {
  category: ReportCategory
  email: string | null
}

/** A waiting-report sample point for the jurisdiction mini-map. */
export interface DiscoverySamplePinRecord {
  category: ReportCategory
  lat: number
  lng: number
}

/** A stored operator note (read back from audit_log rows of action discovery.note_added). */
export interface DiscoveryNoteRecord {
  text: string
  who: string
  createdAt: Date
}

/**
 * A citizen-suggested routing contact for a geoid (public POST /map/jurisdictions/:geoid/suggest-contact,
 * stored as an audit_log `discovery.contact_suggested` row). Surfaced in the discovery detail as a
 * "Reporter" note so the operator triages it alongside operator notes in the existing UI.
 */
export interface DiscoveryContactSuggestionRecord {
  email: string | null
  formUrl: string | null
  note: string | null
  createdAt: Date
}

/** The detail bundle: the task record + its existing contacts + geometry + sample pins. */
export interface DiscoveryDetailRecord {
  task: DiscoveryTaskRecord
  contacts: DiscoveryContactRecord[]
  placeGeojson: unknown | null
  samplePins: DiscoverySamplePinRecord[]
  center: [number, number] | null
  zoom: number | null
}

/** Filter facet for the list (mirrors the shared DiscoveryListQuery filter). */
export type DiscoveryFilter = "all" | "attention" | "clear"
/** Sort key for the list (mirrors the shared DiscoveryListQuery sort). */
export type DiscoverySort = "pop" | "reports"

/** Normalized list arguments the repo consumes (search + facet + sort + page window). */
export interface ListDiscoveryArgs {
  q: string | null
  filter: DiscoveryFilter
  sort: DiscoverySort
  cursor: string | null
  limit: number
}

/**
 * Persistence seam for the discovery domain. The Drizzle impl runs raw SQL (PostGIS for the sample
 * pins); the offline tests pass an in-memory impl. Keeping every read/write here is what makes the
 * service unit-testable with no DB.
 */
export interface DiscoveryRepository {
  /**
   * Page the open discovery tasks (each joined with its jurisdiction + waiting aggregates), applying
   * the search / facet filter and the sort, newest-id-keyset paged. Returns up to `limit` records plus
   * the next cursor (null when exhausted). The repo is responsible for the filter + sort semantics so
   * the service stays a pure projector.
   */
  listTasks(args: ListDiscoveryArgs): Promise<{ records: DiscoveryTaskRecord[]; nextCursor: string | null }>
  /** Load one task's full detail by task id, or null when the task does not exist. */
  getDetail(id: string): Promise<DiscoveryDetailRecord | null>
  /** Load the notes for a task, oldest first. */
  listNotes(id: string): Promise<DiscoveryNoteRecord[]>
  /**
   * Load citizen contact suggestions for a geoid (public suggest-contact submissions), oldest first.
   * Surfaced as "Reporter" notes in the detail so operators triage them in the existing discovery UI.
   */
  listContactSuggestions(geoid: string): Promise<DiscoveryContactSuggestionRecord[]>
  /** Load the bare task record (no contacts/geometry) by id, or null. Used to resolve geoid for writes. */
  getTask(id: string): Promise<DiscoveryTaskRecord | null>
  /**
   * Append an operator note for a task (persisted as an audit_log discovery.note_added row). `who` is
   * the operator display label stored in the note. Returns the stored note.
   */
  addNote(id: string, input: { text: string; actorId: string | null; who: string }): Promise<DiscoveryNoteRecord>
  /**
   * Flag a task for review: open an abuse_flag against the triggering sample report (subject_type
   * 'report') when one is on file, and mark the task status 'in_progress'. Returns false when the task
   * does not exist (so the route can 404).
   */
  flagTask(id: string, input: { reason: string | null; actorId: string | null }): Promise<boolean>
  /**
   * Save contact drafts WITHOUT routing: upsert the per-category + default jurisdiction_contacts rows
   * and the form URL, but do NOT touch contact_updated_at, route pending pins, or enqueue outreach.
   * Returns false when the task does not exist.
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
   * Materialize (idempotently) an OPEN discovery task for a geoid: the `jurisdiction.discovery` worker
   * calls this when a report's jurisdiction has no usable contact, so the operator's Discovery queue shows
   * the un-onboarded jurisdiction. Inserts one row per geoid (ON CONFLICT (geoid) WHERE status <> 'done'
   * DO NOTHING), wiring the population + a sample report. Returns whether a NEW task row was created (false
   * when an open task already existed or the jurisdiction is unknown).
   */
  materializeDiscoveryTask(input: { geoid: string; population?: number | null }): Promise<boolean>
}

// ---------------------------------------------------------------------------
// Pure helpers (no DB, no IO)
// ---------------------------------------------------------------------------

/** Fill a per-category count map so every real category is present (0 when no waiting reports). */
export function fullPerCategoryCounts(
  partial: Partial<Record<ReportCategory, number>>,
): PerCategoryCounts {
  const out = {} as Record<ReportCategory, number>
  for (const category of DISCOVERY_CATEGORIES) {
    out[category] = partial[category] ?? 0
  }
  return out
}

/**
 * The dominant waiting category (the one with the most waiting reports; ties broken by the canonical
 * category order). Falls back to "other" when there are no waiting reports, so the row always has a pin.
 */
export function dominantCategory(partial: Partial<Record<ReportCategory, number>>): ReportCategory {
  let best: ReportCategory = "other"
  // Start at 0 so a category only becomes dominant when it has at least one waiting report; an all-zero
  // map (no waiting reports) keeps the neutral "other" default rather than the first category.
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
 * Compute the routed-vs-missing contact state for a task. A category is "routed" when it has its own
 * per-category contact OR (a default/legacy contact exists). EVERY category with waiting reports that is
 * not routed is "missing"; categories with no waiting reports and no contact are neither (they do not
 * demand attention). This matches the design's "any report-type has reports waiting but no contact"
 * attention predicate.
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
      // Only surface a routed category when it is relevant (has waiting reports OR an explicit contact).
      if (waiting || routedSet.has(category)) routed.push(category)
    } else if (waiting) {
      missing.push(category)
    }
  }
  return { routed, missing }
}

/** A task "needs attention" when it has at least one waiting report whose category has no contact. */
export function needsAttention(record: DiscoveryTaskRecord): boolean {
  return computeContactState(record).missing.length > 0
}

/** Whether the oldest waiting report breaches the discovery SLA as of `now`. */
export function isOverSla(oldestWaitingAt: Date | null, now: Date): boolean {
  if (oldestWaitingAt === null) return false
  const ageMs = now.getTime() - oldestWaitingAt.getTime()
  return ageMs > DISCOVERY_SLA_HOURS * 60 * 60 * 1000
}

/**
 * Derive the urgency band (low|med|high) shown on a queue row. The design's `priority` is an urgency
 * band, NOT the jurisdictions.priority layer ordinal (place<county<state), so it is COMPUTED from the
 * queue signals rather than read from that column: an SLA breach is high; any waiting reports is med;
 * an idle task is low. Pure + clock-injected so the band is deterministic in tests.
 */
export function derivePriority(record: DiscoveryTaskRecord, now: Date): Priority {
  if (isOverSla(record.oldestWaitingAt, now)) return "high"
  if (record.total > 0) return "med"
  return "low"
}

/**
 * Render a citizen contact suggestion as an operator-facing note record ("Reporter" + a one-line
 * summary of the offered email/form + any note). Pure so the projection is testable and identical
 * regardless of which repo loaded the suggestion.
 */
export function suggestionToNote(s: DiscoveryContactSuggestionRecord): DiscoveryNoteRecord {
  const contact = [s.email, s.formUrl]
    .filter((v): v is string => !!v && v.trim() !== "")
    .join(" / ")
  const head = `Suggested contact: ${contact || "(none provided)"}`
  return {
    who: "Reporter",
    text: s.note && s.note.trim() !== "" ? `${head} — ${s.note.trim()}` : head,
    createdAt: s.createdAt,
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface DiscoveryServiceDeps {
  repo: DiscoveryRepository
  /** Injectable clock (defaults to Date.now) so the SLA + relative-age labels are deterministic. */
  now?: () => Date
}

export interface DiscoveryService {
  list(query: DiscoveryListQuery): Promise<DiscoveryListResponse>
  getTask(id: string): Promise<DiscoveryTaskDetailDTO>
  addNote(id: string, input: { text: string; actorId: string | null; who: string }): Promise<DiscoveryNote>
  flag(id: string, input: { reason: string | null; actorId: string | null }): Promise<void>
  saveDraft(
    id: string,
    input: {
      contacts: Partial<Record<ReportCategory, string | null>>
      defaultEmails: string[]
      formUrl: string | null
      actorId: string | null
    },
  ): Promise<void>
}

export function makeDiscoveryService(deps: DiscoveryServiceDeps): DiscoveryService {
  const now = deps.now ?? (() => new Date())

  /** Project a stored note record into the wire DTO (relative "when" label). */
  function toNoteDTO(record: DiscoveryNoteRecord, ref: Date): DiscoveryNote {
    return { text: record.text, who: record.who, when: relativeAgo(record.createdAt, ref) }
  }

  /** Project a task record (+ its notes) into the list/detail base DTO. */
  function toTaskDTO(record: DiscoveryTaskRecord, notes: DiscoveryNoteRecord[], ref: Date): DiscoveryTaskDTO {
    const category = dominantCategory(record.perCategory)
    return {
      id: record.id,
      geoid: record.geoid,
      place: record.place,
      layer: record.layer,
      category,
      catLabel: CATEGORY_LABELS[category],
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
      // The list rows do not render notes inline (only the detail does), so the list returns an empty
      // notes[] per row rather than fanning out a note read per task (the DTO requires the field).
      const items = records.map((record) => toTaskDTO(record, [], ref))
      return { items, nextCursor }
    },

    async getTask(id: string): Promise<DiscoveryTaskDetailDTO> {
      const ref = now()
      const [detail, notes] = await Promise.all([deps.repo.getDetail(id), deps.repo.listNotes(id)])
      if (!detail) throw AppError.notFound("Discovery task not found")

      // Merge citizen contact suggestions (keyed by geoid) into the note stream as "Reporter" notes so
      // operators see them inline in the existing discovery detail UI, interleaved oldest-first.
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
        // Pins are real waiting reports (not operator-drafted markers), so draft is always false.
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
      input: { text: string; actorId: string | null; who: string },
    ): Promise<DiscoveryNote> {
      const ref = now()
      const task = await deps.repo.getTask(id)
      if (!task) throw AppError.notFound("Discovery task not found")
      const note = await deps.repo.addNote(id, input)
      return toNoteDTO(note, ref)
    },

    async flag(id: string, input: { reason: string | null; actorId: string | null }): Promise<void> {
      const ok = await deps.repo.flagTask(id, input)
      if (!ok) throw AppError.notFound("Discovery task not found")
    },

    async saveDraft(
      id: string,
      input: {
        contacts: Partial<Record<ReportCategory, string | null>>
        defaultEmails: string[]
        formUrl: string | null
        actorId: string | null
      },
    ): Promise<void> {
      const ok = await deps.repo.saveDraft(id, input)
      if (!ok) throw AppError.notFound("Discovery task not found")
    },
  }
}
