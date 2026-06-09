/**
 * In-memory JurisdictionContactsRepository (Phase 2): the offline binding of the contacts persistence
 * seam, faithful to the Drizzle impl's observable behavior so the service is unit-testable with NO
 * database (no Docker):
 *   - saveAndRoute upserts the per-category + default contacts, sets contactUpdatedAt, marks the open
 *     discovery task for the geoid 'done', and routes every waiting report (-> acknowledged), returning
 *     the routed count + whether a task resolved. It deliberately does NOT touch outreach_state (C1):
 *     the Drizzle saveAndRoute no longer stamps last_outreach_at at save time either, so the send window
 *     is started only when a digest is actually sent. The two impls therefore agree exactly (C2): the
 *     immediate-outreach path the service enqueues after save is not throttled-by-construction;
 *   - patch upserts the provided contact fields + notes without routing;
 *   - getOutreachState reads the throttle state (from a SHARED outreach store when injected, so a test can
 *     wire the same outreach_state the OutreachService stamps and exercise the real save -> send -> stamp
 *     -> throttle coupling end to end);
 *   - listDirectory pages the seeded jurisdictions with the method facet + search.
 * Seed/inspect helpers (seedJurisdiction, seedReport, seedTask, seedOutreach, the public maps) let tests
 * arrange + assert state directly.
 */

import { randomUUID } from "node:crypto"
import { clampLimit, decodeCursor, encodeCursor } from "./pagination.js"
import type { OutreachStateRecord } from "./mail-repository.drizzle.js"
import {
  directoryMethod,
  type JurisdictionContactsRepository,
  type JurisdictionDirectoryRecord,
  type ListDirectoryArgs,
  type SaveContactsInput,
} from "./jurisdiction-contacts-service.js"
import type { JurisdictionLayer, ReportCategory } from "@civfix/shared"

/** A seeded jurisdiction's mutable contact + routing state. */
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
}

/** A seeded report (the subset the routing path mutates). */
export interface SeededReport {
  id: string
  geoid: string
  category: ReportCategory
  status: string
  deletedAt: Date | null
  createdAt: Date
}

/** A seeded discovery task (the subset save-and-route resolves). */
export interface SeededContactsTask {
  id: string
  geoid: string
  status: string
}

/** Statuses that are NOT waiting (already closed / already routed). */
const NON_WAITING = new Set(["rejected", "resolved", "acknowledged", "in_progress"])

/** A recorded audit row (mirrors the Drizzle impl's in-tx writeAudit), inspectable by tests (H4). */
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
  /**
   * The outreach throttle store this repo reads. Defaults to its own map, but a test can inject the SAME
   * map the OutreachService (via the in-memory mail repo) stamps, so the save -> enqueue -> send -> stamp
   * -> throttle loop is exercised against one shared outreach_state (mirroring the single production
   * table). The record type is the mail repo's OutreachStateRecord (a superset of what this repo reads).
   */
  readonly outreach: Map<string, OutreachStateRecord>
  /** Recorded audit rows (the in-tx writeAudit mirror), so tests can assert the save/patch was audited. */
  readonly audits: RecordedContactsAudit[] = []

  /** Deterministic clock used for contactUpdatedAt / lastRoutedAt writes. */
  now = new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 0))

  /** @param sharedOutreach optional throttle store shared with the mail repo (the production single table). */
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
  ): Promise<{ routedReports: number; taskResolved: boolean }> {
    const j = this.jurisdictions.get(geoid)
    if (!j) return { routedReports: 0, taskResolved: false }

    applyContacts(j, input)
    j.contactUpdatedAt = this.now
    j.lastRoutedAt = this.now

    // Mark the open discovery task(s) for this geoid resolved.
    let taskResolved = false
    for (const t of this.tasks) {
      if (t.geoid === geoid && t.status !== "done") {
        t.status = "done"
        taskResolved = true
      }
    }

    // Route the waiting reports: move every open, non-deleted, not-yet-routed report to acknowledged.
    let routedReports = 0
    for (const r of this.reports) {
      if (r.geoid === geoid && r.deletedAt === null && !NON_WAITING.has(r.status)) {
        r.status = "acknowledged"
        routedReports += 1
      }
    }

    // Mirror the Drizzle in-tx audit (H4) so the service/route tests can assert the save was recorded.
    this.audits.push({
      actorId: audit.actorId,
      action: "discovery.contacts_saved",
      target: `jurisdiction:${geoid}`,
      meta: {
        geoid,
        categories: Object.keys(input.contacts),
        defaultEmails: input.defaultEmails,
        routedReports,
        taskResolved,
      },
    })

    return { routedReports, taskResolved }
  }

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
    // Flag / unflag for review: set stamps flaggedAt + reason; clear nulls both (mirrors the Drizzle impl).
    if (input.flagged !== undefined) {
      j.flaggedAt = input.flagged ? this.now : null
      j.flagReason = input.flagged ? (input.flagReason ?? null) : null
    }
    if (touchedContact) j.contactUpdatedAt = this.now
    // Mirror the Drizzle in-tx audit (H4).
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

  async listDirectory(
    args: ListDirectoryArgs,
  ): Promise<{ records: JurisdictionDirectoryRecord[]; nextCursor: string | null }> {
    let records = [...this.jurisdictions.values()].map((j) => toRecord(j, this.reports))

    if (args.q !== null) {
      const needle = args.q.toLowerCase()
      records = records.filter(
        (r) => r.name.toLowerCase().includes(needle) || r.geoid.toLowerCase().includes(needle),
      )
    }
    if (args.filter !== "all") {
      records = records.filter((r) => directoryMethod(r) === args.filter)
    }

    // Stable sort by geoid (deterministic keyset for the unit tests).
    records.sort((a, b) => (a.geoid < b.geoid ? -1 : a.geoid > b.geoid ? 1 : 0))

    const limit = clampLimit(args.limit)
    const anchor = decodeCursor(args.cursor)
    let start = 0
    if (anchor) {
      const idx = records.findIndex((r) => r.geoid === anchor.id)
      start = idx >= 0 ? idx + 1 : records.length
    }
    const slice = records.slice(start, start + limit + 1)
    if (slice.length <= limit) {
      return { records: slice, nextCursor: null }
    }
    const page = slice.slice(0, limit)
    const last = page[page.length - 1]
    const nextCursor = last ? encodeCursor({ createdAt: this.now, id: last.geoid }) : null
    return { records: page, nextCursor }
  }
}

/** Apply a contact-save input to a seeded jurisdiction (per-category + default + form mirror). */
function applyContacts(j: SeededJurisdiction, input: SaveContactsInput): void {
  for (const [category, email] of Object.entries(input.contacts) as [
    ReportCategory,
    string | null,
  ][]) {
    const normalized = email && email.trim() !== "" ? email.trim() : null
    if (normalized === null) j.categoryContacts.delete(category)
    else j.categoryContacts.set(category, normalized)
  }
  const emails = input.defaultEmails.filter((e) => e.trim() !== "")
  if (emails.length > 0) j.defaultEmails = emails
  if (emails.length > 0) j.hasDefaultContact = true
  if (input.formUrl !== null && input.formUrl.trim() !== "") {
    j.reportFormUrl = input.formUrl.trim()
    j.hasDefaultContact = true
  }
}

/** Project a seeded jurisdiction into the directory record the service consumes. */
function toRecord(j: SeededJurisdiction, reports: SeededReport[]): JurisdictionDirectoryRecord {
  // Waiting = open, un-routed reports for this geoid (same NON_WAITING exclusion the Drizzle query uses).
  const perCategoryCounts: Partial<Record<ReportCategory, number>> = {}
  let reportsWaiting = 0
  for (const r of reports) {
    if (r.geoid === j.geoid && r.deletedAt === null && !NON_WAITING.has(r.status)) {
      reportsWaiting += 1
      perCategoryCounts[r.category] = (perCategoryCounts[r.category] ?? 0) + 1
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
    lastRoutedAt: j.lastRoutedAt,
    bounced: j.bounced,
    contactUpdatedAt: j.contactUpdatedAt,
    flaggedAt: j.flaggedAt,
  }
}

