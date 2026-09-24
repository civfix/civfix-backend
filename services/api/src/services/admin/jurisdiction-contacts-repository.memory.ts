import { randomUUID } from "node:crypto"
import { clampLimit, decodeOffsetCursor, encodeOffsetCursor } from "./pagination.js"
import type { OutreachStateRecord } from "./mail-repository.drizzle.js"
import {
  buildUnmappedRecord,
  directoryMethod,
  shouldIncludeUnmapped,
} from "./jurisdiction-directory-projection.js"
import type {
  JurisdictionContactsRepository,
  JurisdictionDirectoryRecord,
  JurisdictionGeometryRecord,
  ListDirectoryArgs,
  ListDirectoryResult,
  PatchContactsInput,
  SaveContactsInput,
} from "./jurisdiction-contacts-types.js"
import { AppError } from "@civfix/shared"
import type { JurisdictionLayer, ReportCategory } from "@civfix/shared"

export interface SeededJurisdiction {
  geoid: string
  name: string
  layer: JurisdictionLayer
  population: number | null
  defaultEmails: string[]
  categoryContacts: Map<ReportCategory, string | null>
  hasDefaultContact: boolean
  reportFormUrl: string | null
  notes: string | null
  lastRoutedAt: Date | null
  bounced: boolean
  contactUpdatedAt: Date | null
  flaggedAt: Date | null
  flagReason: string | null
  handle: string | null
  forwardSubjectTemplate: string | null
  forwardBodyTemplate: string | null
}

export interface SeededReport {
  id: string
  geoid: string
  category: ReportCategory
  status: string
  deletedAt: Date | null
  createdAt: Date
}

export interface SeededContactsTask {
  id: string
  geoid: string
  status: string
}

const NON_WAITING = new Set(["rejected", "resolved", "acknowledged", "in_progress"])

export interface RecordedContactsAudit {
  actorId: string | null
  action: string
  target: string
  meta: Record<string, unknown>
}

export class InMemoryJurisdictionContactsRepository implements JurisdictionContactsRepository {
  readonly jurisdictions = new Map<string, SeededJurisdiction>()
  readonly reports: SeededReport[] = []
  readonly tasks: SeededContactsTask[] = []
  readonly outreach: Map<string, OutreachStateRecord>
  readonly audits: RecordedContactsAudit[] = []

  now = new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 0))

  constructor(sharedOutreach?: Map<string, OutreachStateRecord>) {
    this.outreach = sharedOutreach ?? new Map<string, OutreachStateRecord>()
  }

  seedJurisdiction(input: {
    geoid: string
    name: string
    layer?: JurisdictionLayer
    population?: number | null
    defaultEmails?: string[]
    categoryContacts?: Partial<Record<ReportCategory, string | null>>
    hasDefaultContact?: boolean
    reportFormUrl?: string | null
    notes?: string | null
    lastRoutedAt?: Date | null
    bounced?: boolean
    contactUpdatedAt?: Date | null
    flaggedAt?: Date | null
    flagReason?: string | null
    handle?: string | null
    forwardSubjectTemplate?: string | null
    forwardBodyTemplate?: string | null
  }): SeededJurisdiction {
    const categoryContacts = new Map<ReportCategory, string | null>()
    for (const [category, email] of Object.entries(input.categoryContacts ?? {}) as [
      ReportCategory,
      string | null,
    ][]) {
      categoryContacts.set(category, email)
    }
    const j: SeededJurisdiction = {
      geoid: input.geoid,
      name: input.name,
      layer: input.layer ?? "place",
      population: input.population ?? null,
      defaultEmails: input.defaultEmails ?? [],
      categoryContacts,
      hasDefaultContact: input.hasDefaultContact ?? false,
      reportFormUrl: input.reportFormUrl ?? null,
      notes: input.notes ?? null,
      lastRoutedAt: input.lastRoutedAt ?? null,
      bounced: input.bounced ?? false,
      contactUpdatedAt: input.contactUpdatedAt ?? null,
      flaggedAt: input.flaggedAt ?? null,
      flagReason: input.flagReason ?? null,
      handle: input.handle ?? null,
      forwardSubjectTemplate: input.forwardSubjectTemplate ?? null,
      forwardBodyTemplate: input.forwardBodyTemplate ?? null,
    }
    this.jurisdictions.set(j.geoid, j)
    return j
  }

  seedReport(input: {
    id?: string
    geoid: string
    category: ReportCategory
    status?: string
    deletedAt?: Date | null
    createdAt?: Date
  }): SeededReport {
    const r: SeededReport = {
      id: input.id ?? randomUUID(),
      geoid: input.geoid,
      category: input.category,
      status: input.status ?? "submitted",
      deletedAt: input.deletedAt ?? null,
      createdAt: input.createdAt ?? this.now,
    }
    this.reports.push(r)
    return r
  }

  seedTask(input: { id?: string; geoid: string; status?: string }): SeededContactsTask {
    const t: SeededContactsTask = {
      id: input.id ?? randomUUID(),
      geoid: input.geoid,
      status: input.status ?? "open",
    }
    this.tasks.push(t)
    return t
  }

  seedOutreach(geoid: string, state: { lastOutreachAt?: Date | null; suppressed?: boolean }): void {
    this.outreach.set(geoid, {
      geoid,
      lastOutreachAt: state.lastOutreachAt ?? null,
      suppressed: state.suppressed ?? false,
    })
  }

  async jurisdictionExists(geoid: string): Promise<boolean> {
    return this.jurisdictions.has(geoid)
  }

  async saveAndRoute(
    geoid: string,
    input: SaveContactsInput,
    audit: { actorId: string | null },
  ): Promise<{ taskResolved: boolean }> {
    const j = this.jurisdictions.get(geoid)
    if (!j) return { taskResolved: false }

    applyContacts(j, input)
    if (input.forwardSubjectTemplate !== undefined) {
      const template = input.forwardSubjectTemplate
      j.forwardSubjectTemplate = template === null || template === "" ? null : template
    }
    if (input.forwardBodyTemplate !== undefined) {
      const template = input.forwardBodyTemplate
      j.forwardBodyTemplate = template === null || template === "" ? null : template
    }
    j.contactUpdatedAt = this.now

    let taskResolved = false
    for (const t of this.tasks) {
      if (t.geoid === geoid && t.status !== "done") {
        t.status = "done"
        taskResolved = true
      }
    }

    this.audits.push({
      actorId: audit.actorId,
      action: "discovery.contacts_saved",
      target: `jurisdiction:${geoid}`,
      meta: {
        geoid,
        categories: Object.keys(input.contacts),
        defaultEmails: input.defaultEmails,
        taskResolved,
      },
    })

    return { taskResolved }
  }

  async patch(
    geoid: string,
    input: PatchContactsInput,
    audit: { actorId: string | null },
  ): Promise<boolean> {
    const j = this.jurisdictions.get(geoid)
    if (!j) return false
    let touchedContact = false
    if (input.contacts || input.defaultEmails || input.formUrl !== undefined) {
      applyContacts(j, {
        contacts: input.contacts ?? {},
        defaultEmails: input.defaultEmails ?? j.defaultEmails,
        formUrl: input.formUrl ?? j.reportFormUrl,
      })
      touchedContact = true
    }
    if (input.notes !== undefined) j.notes = input.notes
    if (input.flagged !== undefined) {
      j.flaggedAt = input.flagged ? this.now : null
      j.flagReason = input.flagged ? (input.flagReason ?? null) : null
    }
    if (input.handle !== undefined) {
      const handle = input.handle
      if (handle === null || handle === "") {
        j.handle = null
      } else {
        for (const other of this.jurisdictions.values()) {
          if (
            other.geoid !== geoid &&
            other.handle !== null &&
            other.handle.toLowerCase() === handle.toLowerCase()
          ) {
            throw AppError.conflict("That @handle is already used by another jurisdiction.")
          }
        }
        j.handle = handle
      }
    }
    if (input.forwardSubjectTemplate !== undefined) {
      const t = input.forwardSubjectTemplate
      j.forwardSubjectTemplate = t === null || t === "" ? null : t
    }
    if (input.forwardBodyTemplate !== undefined) {
      const t = input.forwardBodyTemplate
      j.forwardBodyTemplate = t === null || t === "" ? null : t
    }
    if (touchedContact) j.contactUpdatedAt = this.now
    this.audits.push({
      actorId: audit.actorId,
      action: "jurisdiction.patched",
      target: `jurisdiction:${geoid}`,
      meta: {
        geoid,
        fields: Object.keys(input).filter(
          (k) => (input as Record<string, unknown>)[k] !== undefined,
        ),
      },
    })
    return true
  }

  async getOutreachState(
    geoid: string,
  ): Promise<{ lastOutreachAt: Date | null; suppressed: boolean } | null> {
    return this.outreach.get(geoid) ?? null
  }

  async listDirectory(args: ListDirectoryArgs): Promise<ListDirectoryResult> {
    const all = [...this.jurisdictions.values()].map((j) => toRecord(j, this.reports))

    const matched =
      args.q !== null
        ? (() => {
            const needle = args.q.toLowerCase()
            return all.filter(
              (r) =>
                r.name.toLowerCase().includes(needle) || r.geoid.toLowerCase().includes(needle),
            )
          })()
        : all
    const searched = args.layer !== null ? matched.filter((r) => r.layer === args.layer) : matched

    const records =
      args.filter === "all"
        ? searched.slice()
        : args.filter === "routed"
          ? searched.filter((r) => directoryMethod(r) !== "none")
          : args.filter === "needs_mapping"
            ? searched.filter((r) => directoryMethod(r) === "none" && r.reportsWaiting > 0)
            : searched.filter((r) => directoryMethod(r) === args.filter)

    const byGeoid = (a: JurisdictionDirectoryRecord, b: JurisdictionDirectoryRecord) =>
      a.geoid < b.geoid ? -1 : a.geoid > b.geoid ? 1 : 0
    records.sort((a, b) => {
      if (args.sort === "name") return a.name < b.name ? -1 : a.name > b.name ? 1 : byGeoid(a, b)
      if (args.sort === "oldest") {
        const at = a.oldestReportAt?.getTime() ?? null
        const bt = b.oldestReportAt?.getTime() ?? null
        if (at === null && bt === null) return byGeoid(a, b)
        if (at === null) return 1
        if (bt === null) return -1
        return at - bt || byGeoid(a, b)
      }
      const av = args.sort === "reports" ? a.reportsWaiting : (a.population ?? 0)
      const bv = args.sort === "reports" ? b.reportsWaiting : (b.population ?? 0)
      return bv - av || byGeoid(a, b)
    })

    const limit = clampLimit(args.limit)
    const offset = decodeOffsetCursor(args.cursor)
    const slice = records.slice(offset, offset + limit + 1)
    const hasMore = slice.length > limit
    const page = hasMore ? slice.slice(0, limit) : slice
    const nextCursor = hasMore ? encodeOffsetCursor(offset + limit) : null

    let total: number | null = null
    let facets: { routed: number; unrouted: number } | null = null
    if (offset === 0) {
      total = records.length
      const routed = searched.filter((r) => directoryMethod(r) !== "none").length
      facets = { routed, unrouted: searched.length - routed }
    }

    if (shouldIncludeUnmapped(args)) {
      const unmapped = this.unmappedAggregate()
      if (unmapped.total > 0) {
        return {
          records: [buildUnmappedRecord(unmapped.total, unmapped.perCategoryCounts), ...page],
          nextCursor,
          total,
          facets,
        }
      }
    }
    return { records: page, nextCursor, total, facets }
  }

  async getGeometry(_geoid: string): Promise<JurisdictionGeometryRecord | null> {
    return null
  }

  private unmappedAggregate(): {
    total: number
    perCategoryCounts: Partial<Record<ReportCategory, number>>
  } {
    const perCategoryCounts: Partial<Record<ReportCategory, number>> = {}
    let total = 0
    for (const r of this.reports) {
      if (r.deletedAt === null && !NON_WAITING.has(r.status) && !this.jurisdictions.has(r.geoid)) {
        total += 1
        perCategoryCounts[r.category] = (perCategoryCounts[r.category] ?? 0) + 1
      }
    }
    return { total, perCategoryCounts }
  }
}

function applyContacts(j: SeededJurisdiction, input: SaveContactsInput): void {
  let wroteEmail = false
  for (const [category, email] of Object.entries(input.contacts) as [
    ReportCategory,
    string | null,
  ][]) {
    const normalized = email && email.trim() !== "" ? email.trim() : null
    if (normalized === null) j.categoryContacts.delete(category)
    else {
      j.categoryContacts.set(category, normalized)
      wroteEmail = true
    }
  }
  const emails = input.defaultEmails.filter((e) => e.trim() !== "")
  if (emails.length > 0) {
    j.defaultEmails = emails
    j.hasDefaultContact = true
    wroteEmail = true
  }
  if (input.formUrl !== null && input.formUrl.trim() !== "") {
    j.reportFormUrl = input.formUrl.trim()
    j.hasDefaultContact = true
  }
  if (wroteEmail) j.bounced = false
}

function toRecord(j: SeededJurisdiction, reports: SeededReport[]): JurisdictionDirectoryRecord {
  const perCategoryCounts: Partial<Record<ReportCategory, number>> = {}
  let reportsWaiting = 0
  let oldestReportAt: Date | null = null
  for (const r of reports) {
    if (r.geoid === j.geoid && r.deletedAt === null && !NON_WAITING.has(r.status)) {
      reportsWaiting += 1
      perCategoryCounts[r.category] = (perCategoryCounts[r.category] ?? 0) + 1
      if (oldestReportAt === null || r.createdAt < oldestReportAt) oldestReportAt = r.createdAt
    }
  }
  return {
    geoid: j.geoid,
    name: j.name,
    layer: j.layer,
    population: j.population,
    defaultEmails: [...j.defaultEmails],
    categoryContacts: [...j.categoryContacts.entries()].map(([category, email]) => ({
      category,
      email,
    })),
    hasDefaultContact: j.hasDefaultContact,
    reportFormUrl: j.reportFormUrl,
    reportsWaiting,
    perCategoryCounts,
    oldestReportAt,
    lastRoutedAt: j.lastRoutedAt,
    bounced: j.bounced,
    contactUpdatedAt: j.contactUpdatedAt,
    flaggedAt: j.flaggedAt,
    handle: j.handle,
    forwardSubjectTemplate: j.forwardSubjectTemplate,
    forwardBodyTemplate: j.forwardBodyTemplate,
  }
}
