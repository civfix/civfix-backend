// Mirrors the Drizzle repository's observable behavior. The waiting-report aggregates are seeded on the
// task record rather than recomputed, since the Drizzle repository derives them in SQL.

import { randomUUID } from "node:crypto"
import { pageInMemoryById } from "../../../src/services/admin/pagination.js"
import { computeContactState } from "../../../src/services/admin/discovery-service.js"
import type {
  DiscoveryContactRecord,
  DiscoveryContactSuggestionRecord,
  DiscoveryDetailRecord,
  DiscoveryNoteRecord,
  DiscoveryRepository,
  DiscoverySamplePinRecord,
  DiscoveryTaskRecord,
  ListDiscoveryArgs,
} from "../../../src/services/admin/discovery-repository.js"
import type { JurisdictionLayer, ReportCategory } from "@civfix/shared"

export interface SeededDiscoveryTask {
  task: DiscoveryTaskRecord
  contacts: DiscoveryContactRecord[]
  placeGeojson: unknown
  samplePins: DiscoverySamplePinRecord[]
  center: [number, number] | null
  zoom: number | null
}

export class InMemoryDiscoveryRepository implements DiscoveryRepository {
  /** Insertion order is preserved for stable paging. */
  readonly tasks = new Map<string, SeededDiscoveryTask>()
  readonly notes = new Map<string, DiscoveryNoteRecord[]>()
  /** Keyed by GEOID, not task id. */
  readonly contactSuggestions = new Map<string, DiscoveryContactSuggestionRecord[]>()

  now = new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 0))
  private tick = 0

  private nextDate(): Date {
    this.tick += 1
    return new Date(this.now.getTime() + this.tick)
  }

  seedTask(input: {
    id?: string
    geoid: string
    place: string
    layer?: JurisdictionLayer
    population?: number | null
    status?: string
    perCategory?: Partial<Record<ReportCategory, number>>
    oldestWaitingAt?: Date | null
    newestWaitingAt?: Date | null
    contactCategories?: ReportCategory[]
    hasDefaultContact?: boolean
    contacts?: DiscoveryContactRecord[]
    placeGeojson?: unknown
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
        layer: input.layer ?? "place",
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

    // Mirrors the SQL `ilikeAnyOf(sql, [j.name, t.geoid], q)`: the geoid, never the task id, which SQL
    // does not search.
    if (args.q !== null) {
      const needle = args.q.toLowerCase()
      rows = rows.filter(
        (r) => r.place.toLowerCase().includes(needle) || r.geoid.toLowerCase().includes(needle),
      )
    }

    if (args.filter === "attention") {
      rows = rows.filter((r) => computeContactState(r).missing.length > 0)
    } else if (args.filter === "clear") {
      rows = rows.filter((r) => computeContactState(r).missing.length === 0)
    }

    // The id tiebreak keeps the keyset cursor deterministic.
    rows.sort((a, b) => {
      const primary =
        args.sort === "reports" ? b.total - a.total : (b.population ?? 0) - (a.population ?? 0)
      if (primary !== 0) return primary
      return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
    })

    // The shared cursor carries a Date, so the sort value rides in its `at` slot as epoch-ms; the
    // Drizzle repository's SQL keyset consumes the same encoding.
    const sortValue = (r: DiscoveryTaskRecord): number =>
      args.sort === "reports" ? r.total : (r.population ?? 0)
    // requireUuid: the Drizzle keyset casts the anchor to uuid and drops a non-uuid anchor (page one), so
    // the fake must discard the same cursors production does.
    return pageInMemoryById(
      rows,
      args.cursor,
      args.limit,
      (r) => ({ at: new Date(sortValue(r)), id: r.id }),
      true,
    )
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
    const note: DiscoveryNoteRecord = {
      text: input.text,
      who: input.who,
      createdAt: this.nextDate(),
    }
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
    if (seeded.task.status !== "done") seeded.task.status = "in_progress"
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

  async materializeDiscoveryTask(input: {
    geoid: string
    population?: number | null
  }): Promise<boolean> {
    // Mirrors ON CONFLICT (geoid) WHERE status <> 'done' DO NOTHING: at most one open task per geoid.
    for (const seeded of this.tasks.values()) {
      if (seeded.task.geoid === input.geoid && seeded.task.status !== "done") return false
    }
    this.seedTask({ geoid: input.geoid, place: input.geoid, population: input.population ?? null })
    return true
  }
}

function upsertContacts(
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

  seeded.task.contactCategories = seeded.contacts
    .filter((c) => c.email !== null && c.email.trim() !== "")
    .map((c) => c.category)
  if (defaultEmails.length > 0) seeded.task.hasDefaultContact = true
}
