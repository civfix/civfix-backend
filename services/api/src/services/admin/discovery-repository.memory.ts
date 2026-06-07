/**
 * In-memory DiscoveryRepository (Phase 2): the offline binding of the discovery persistence seam.
 *
 * Mirrors the Drizzle impl's OBSERVABLE contract so the discovery service can be unit-tested with NO
 * database (no Docker), the same way InMemoryMailRepository backs the mail tests:
 *   - listTasks applies the search (place/id) + the attention/clear facet + the pop|reports sort and
 *     pages newest-id-keyset;
 *   - getDetail/getTask/listNotes read the seeded task + its contacts + notes;
 *   - addNote appends a note (the Drizzle impl persists it as an audit_log discovery.note_added row;
 *     here it is appended to the task's note list with the same observable result);
 *   - flagTask marks the task in_progress (+ would open an abuse_flag in the Drizzle impl);
 *   - saveDraft upserts the per-category + default contacts WITHOUT routing.
 * Seed/inspect helpers (seedTask, the public tasks/contacts/notes maps) let tests arrange + assert
 * state directly. The waiting-report aggregates (perCategory/total/oldest/newest/sample pins) are seeded
 * on the task record rather than recomputed, since the Drizzle impl derives them in SQL.
 */

import { randomUUID } from "node:crypto"
import { clampLimit, decodeCursor, encodeCursor } from "./pagination.js"
import {
  computeContactState,
  type DiscoveryContactRecord,
  type DiscoveryContactSuggestionRecord,
  type DiscoveryDetailRecord,
  type DiscoveryNoteRecord,
  type DiscoveryRepository,
  type DiscoverySamplePinRecord,
  type DiscoveryTaskRecord,
  type ListDiscoveryArgs,
} from "./discovery-service.js"
import type { ReportCategory } from "@civfix/shared"

/** A seeded discovery task plus its detail extras (contacts/geometry/pins) held in one place. */
export interface SeededDiscoveryTask {
  task: DiscoveryTaskRecord
  contacts: DiscoveryContactRecord[]
  placeGeojson: unknown | null
  samplePins: DiscoverySamplePinRecord[]
  center: [number, number] | null
  zoom: number | null
}

/** An in-memory DiscoveryRepository faithful to the Drizzle impl's observable behavior. */
export class InMemoryDiscoveryRepository implements DiscoveryRepository {
  /** Seeded tasks keyed by task id (insertion order preserved for stable paging). */
  readonly tasks = new Map<string, SeededDiscoveryTask>()
  /** Notes keyed by task id, oldest first. */
  readonly notes = new Map<string, DiscoveryNoteRecord[]>()
  /** Citizen contact suggestions keyed by GEOID (not task id), oldest first. */
  readonly contactSuggestions = new Map<string, DiscoveryContactSuggestionRecord[]>()

  /** Deterministic clock for note timestamps; each note advances by one millisecond. */
  now = new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 0))
  private tick = 0

  private nextDate(): Date {
    this.tick += 1
    return new Date(this.now.getTime() + this.tick)
  }

  /** Seed a task. Defaults fill the aggregates so a test only sets what it asserts on. */
  seedTask(input: {
    id?: string
    geoid: string
    place: string
    population?: number | null
    status?: string
    perCategory?: Partial<Record<ReportCategory, number>>
    oldestWaitingAt?: Date | null
    newestWaitingAt?: Date | null
    contactCategories?: ReportCategory[]
    hasDefaultContact?: boolean
    contacts?: DiscoveryContactRecord[]
    placeGeojson?: unknown | null
    samplePins?: DiscoverySamplePinRecord[]
    center?: [number, number] | null
    zoom?: number | null
  }): SeededDiscoveryTask {
    const id = input.id ?? randomUUID()
    const perCategory = input.perCategory ?? {}
    const total = Object.values(perCategory).reduce((sum, n) => sum + (n ?? 0), 0)
    const seeded: SeededDiscoveryTask = {
      task: {
        id,
        geoid: input.geoid,
        place: input.place,
        population: input.population ?? null,
        status: input.status ?? "open",
        perCategory,
        total,
        oldestWaitingAt: input.oldestWaitingAt ?? null,
        newestWaitingAt: input.newestWaitingAt ?? null,
        contactCategories: input.contactCategories ?? [],
        hasDefaultContact: input.hasDefaultContact ?? false,
      },
      contacts: input.contacts ?? [],
      placeGeojson: input.placeGeojson ?? null,
      samplePins: input.samplePins ?? [],
      center: input.center ?? null,
      zoom: input.zoom ?? null,
    }
    this.tasks.set(id, seeded)
    return seeded
  }

  async listTasks(
    args: ListDiscoveryArgs,
  ): Promise<{ records: DiscoveryTaskRecord[]; nextCursor: string | null }> {
    let rows = [...this.tasks.values()].map((s) => s.task)

    // Search: place OR id, case-insensitive.
    if (args.q !== null) {
      const needle = args.q.toLowerCase()
      rows = rows.filter(
        (r) => r.place.toLowerCase().includes(needle) || r.id.toLowerCase().includes(needle),
      )
    }

    // Facet: attention = has a waiting report whose category lacks a contact; clear = otherwise.
    if (args.filter === "attention") {
      rows = rows.filter((r) => computeContactState(r).missing.length > 0)
    } else if (args.filter === "clear") {
      rows = rows.filter((r) => computeContactState(r).missing.length === 0)
    }

    // Sort: pop (population desc) or reports (waiting total desc). Id is the stable tiebreak (desc) so
    // the keyset cursor pages deterministically.
    rows.sort((a, b) => {
      const primary =
        args.sort === "reports" ? b.total - a.total : (b.population ?? 0) - (a.population ?? 0)
      if (primary !== 0) return primary
      return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
    })

    // Keyset over a synthetic (sortValue, id) anchor encoded in the cursor's createdAt slot. The shared
    // cursor helper carries a Date; we encode the sort value as epoch-ms so the format stays "<iso>|<id>"
    // compatible without a bespoke cursor. For the in-memory repo we page by array position after the
    // anchor id, which is sufficient + deterministic for the unit tests.
    const limit = clampLimit(args.limit)
    const anchor = decodeCursor(args.cursor)
    let start = 0
    if (anchor) {
      const idx = rows.findIndex((r) => r.id === anchor.id)
      start = idx >= 0 ? idx + 1 : rows.length
    }
    const slice = rows.slice(start, start + limit + 1)
    if (slice.length <= limit) {
      return { records: slice, nextCursor: null }
    }
    const records = slice.slice(0, limit)
    const last = records[records.length - 1]
    const nextCursor = last ? encodeCursor({ createdAt: this.now, id: last.id }) : null
    return { records, nextCursor }
  }

  async getDetail(id: string): Promise<DiscoveryDetailRecord | null> {
    const seeded = this.tasks.get(id)
    if (!seeded) return null
    return {
      task: seeded.task,
      contacts: seeded.contacts,
      placeGeojson: seeded.placeGeojson,
      samplePins: seeded.samplePins,
      center: seeded.center,
      zoom: seeded.zoom,
    }
  }

  async listNotes(id: string): Promise<DiscoveryNoteRecord[]> {
    return [...(this.notes.get(id) ?? [])]
  }

  /** Seed a citizen contact suggestion for a geoid (tests). Advances the deterministic clock. */
  seedSuggestion(
    geoid: string,
    input: { email?: string | null; formUrl?: string | null; note?: string | null },
  ): DiscoveryContactSuggestionRecord {
    const rec: DiscoveryContactSuggestionRecord = {
      email: input.email ?? null,
      formUrl: input.formUrl ?? null,
      note: input.note ?? null,
      createdAt: this.nextDate(),
    }
    const list = this.contactSuggestions.get(geoid) ?? []
    list.push(rec)
    this.contactSuggestions.set(geoid, list)
    return rec
  }

  async listContactSuggestions(geoid: string): Promise<DiscoveryContactSuggestionRecord[]> {
    return [...(this.contactSuggestions.get(geoid) ?? [])]
  }

  async getTask(id: string): Promise<DiscoveryTaskRecord | null> {
    return this.tasks.get(id)?.task ?? null
  }

  async addNote(
    id: string,
    input: { text: string; actorId: string | null; who: string },
  ): Promise<DiscoveryNoteRecord> {
    const note: DiscoveryNoteRecord = { text: input.text, who: input.who, createdAt: this.nextDate() }
    const list = this.notes.get(id) ?? []
    list.push(note)
    this.notes.set(id, list)
    return note
  }

  async flagTask(
    id: string,
    _input: { reason: string | null; actorId: string | null },
  ): Promise<boolean> {
    const seeded = this.tasks.get(id)
    if (!seeded) return false
    seeded.task.status = "in_progress"
    return true
  }

  async saveDraft(
    id: string,
    input: {
      contacts: Partial<Record<ReportCategory, string | null>>
      defaultEmails: string[]
      formUrl: string | null
      actorId: string | null
    },
  ): Promise<boolean> {
    const seeded = this.tasks.get(id)
    if (!seeded) return false
    upsertContacts(seeded, input.contacts, input.defaultEmails)
    return true
  }
}

/**
 * Apply a per-category contact map + default emails to a seeded task's contact list + contactCategories
 * (shared by saveDraft here and the contacts service's in-memory save-and-route, so both repos mutate
 * the seeded state identically). A null email clears that category.
 */
export function upsertContacts(
  seeded: SeededDiscoveryTask,
  contacts: Partial<Record<ReportCategory, string | null>>,
  defaultEmails: string[],
): void {
  const byCategory = new Map<ReportCategory, string | null>()
  for (const c of seeded.contacts) byCategory.set(c.category, c.email)
  for (const [category, email] of Object.entries(contacts) as [ReportCategory, string | null][]) {
    byCategory.set(category, email)
  }
  seeded.contacts = [...byCategory.entries()].map(([category, email]) => ({ category, email }))

  // contactCategories reflects categories with a non-null per-category email.
  seeded.task.contactCategories = seeded.contacts
    .filter((c) => c.email !== null && c.email.trim() !== "")
    .map((c) => c.category)
  if (defaultEmails.length > 0) seeded.task.hasDefaultContact = true
}
