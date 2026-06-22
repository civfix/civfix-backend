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
  handle: string | null
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
    handle?: string | null
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
    // Flag / unflag for review: set stamps flaggedAt + reason; clear nulls both (mirrors the Drizzle impl).
    if (input.flagged !== undefined) {
      j.flaggedAt = input.flagged ? this.now : null
      j.flagReason = input.flagged ? (input.flagReason ?? null) : null
    }
    // Set / clear the @handle (mirrors the Drizzle impl): empty/null clears it; a non-empty handle must be
    // case-insensitively unique across OTHER jurisdictions, else a conflict (the Drizzle impl additionally
    // guards against a user-handle collision, which this in-memory double has no users to check).
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

  async markContactBounced(email: string): Promise<void> {
    // Mark every seeded jurisdiction whose default OR per-category contact carries this address as bounced
    // (mirrors the Drizzle UPDATE ... WHERE email = $1 stamping bounced_at, surfaced as the directory flag).
    for (const j of this.jurisdictions.values()) {
      const inDefault = j.defaultEmails.includes(email)
      const inCategory = [...j.categoryContacts.values()].includes(email)
      if (inDefault || inCategory) j.bounced = true
    }
  }

  async listDirectory(args: ListDirectoryArgs): Promise<ListDirectoryResult> {
    const all = [...this.jurisdictions.values()].map((j) => toRecord(j, this.reports))

    // Search + type (layer) first — both scope the chip facets, which stay routing-filter-agnostic
    // (mirroring the Drizzle aggregate's `WHERE search AND layer`, but NOT the methodFilter).
    const matched =
      args.q !== null
        ? (() => {
            const needle = args.q.toLowerCase()
            return all.filter(
              (r) => r.name.toLowerCase().includes(needle) || r.geoid.toLowerCase().includes(needle),
            )
          })()
        : all
    const searched = args.layer !== null ? matched.filter((r) => r.layer === args.layer) : matched

    // Routing-posture facet ("routed" = any contact, i.e. method !== "none").
    let records =
      args.filter === "all"
        ? searched.slice()
        : args.filter === "routed"
          ? searched.filter((r) => directoryMethod(r) !== "none")
          : searched.filter((r) => directoryMethod(r) === args.filter)

    // Whole-table sort (mirrors the Drizzle ORDER BY): population/reports DESC, name A->Z, geoid tiebreak.
    const byGeoid = (a: JurisdictionDirectoryRecord, b: JurisdictionDirectoryRecord) =>
      a.geoid < b.geoid ? -1 : a.geoid > b.geoid ? 1 : 0
    records.sort((a, b) => {
      if (args.sort === "name") return a.name < b.name ? -1 : a.name > b.name ? 1 : byGeoid(a, b)
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

    // total + facets only on the first page, scoped to the search (NOT the filter).
    let total: number | null = null
    let facets: { routed: number; unrouted: number } | null = null
    if (offset === 0) {
      total = searched.length
      const routed = searched.filter((r) => directoryMethod(r) !== "none").length
      facets = { routed, unrouted: searched.length - routed }
    }

    // Prepend the synthetic "Unmapped / Unknown jurisdiction" row on the first page (mirrors the Drizzle
    // impl): waiting reports whose geoid is not a seeded jurisdiction (orphaned/unresolved) aggregate here.
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

  // The in-memory fake stores no geometry, so the verification map has nothing to render here. Tests that
  // need geometry exercise the Drizzle impl against PostGIS; the service 404s on this null.
  async getGeometry(_geoid: string): Promise<JurisdictionGeometryRecord | null> {
    return null
  }

  /** Aggregate waiting reports whose geoid is not a seeded jurisdiction (the in-memory "unmapped" set). */
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

/** Apply a contact-save input to a seeded jurisdiction (per-category + default + form mirror). */
function applyContacts(j: SeededJurisdiction, input: SaveContactsInput): void {
  // A re-entered address is presumed good: clear the bounce marker on any save (mirrors the Drizzle
  // upsert nulling bounced_at). §2.9.
  j.bounced = false
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
    handle: j.handle,
  }
}

