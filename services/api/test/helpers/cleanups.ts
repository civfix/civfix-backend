/**
 * Offline cleanups test helper: an in-memory CleanupRepository (+ a tiny users store for the organizer
 * person join).
 *
 * Mirrors the auth/media/reports in-memory seams so the cleanup SERVICE and the cleanup HTTP ROUTES can
 * be exercised with NO database (no Docker). It is faithful to the Drizzle/PostGIS impl's observable
 * contract:
 *   - createCleanupTx is "atomic": it inserts the cleanup AND the organizer's cleanup_members(organizer)
 *     row together (membership == chat membership). There is no half-created state to observe.
 *   - joinCleanupTx upserts a member row idempotently (re-joining is a no-op) and returns whether the
 *     cleanup exists; leaveCleanup deletes a member row and returns whether the cleanup exists.
 *   - listCleanups filters by when (upcoming = scheduled_at >= now and status != cancelled; past =
 *     scheduled_at < now; omitted = exclude cancelled), optional bbox (point-in-envelope), optional near
 *     (order by distance), and pages with a keyset cursor.
 *
 * The Drizzle-backed repository is covered by the Docker-gated integration test; this fake exercises the
 * same CleanupRepository seam locally.
 */

import { randomUUID } from "node:crypto"
import { AppError } from "@civfix/shared"
import type {
  AttendeeView,
  CancelCleanupOutcome,
  ClaimSlotOutcome,
  CleanupBBox,
  CleanupPersonView,
  CleanupRecord,
  CleanupRepository,
  CompleteCleanupOutcome,
  CreateCleanupTxArgs,
  DesiredSlot,
  EventSlotView,
  LinkedEventView,
  LinkedReportView,
  ListAttendeesArgs,
  ListCleanupsFilters,
  NearPoint,
  SlotReconcileResult,
  UpdateCleanupPatch,
} from "../../src/services/cleanup-service.js"
import type { CleanupMemberRole, EventKind, ReportCategory, ReportStatus } from "@civfix/shared"
import { eventScopeKey, formatReferenceCode, EVENT_PREFIX } from "../../src/db/reference-code.js"
// The CANONICAL keyset primitives cleanup-repository.drizzle.ts uses — imported, never re-implemented, so
// the fake cannot drift into accepting a cursor the production parser rejects (or vice versa).
import {
  encodeNearCursor,
  encodeTimeCursor,
  pageWith,
  parseNearCursor,
  parseTimeCursor,
} from "../../src/db/cursor-helpers.js"
// The CANONICAL public-visibility status set (report-visibility.ts / PUBLIC_REPORT_STATUSES) — the same
// source publicReportFilter's SQL twin reads. Imported, never re-typed as `status === "published"`: the
// widening to published/acknowledged/in_progress/resolved must not have to be applied twice.
import { isPubliclyVisibleStatus } from "../../src/services/report-visibility.js"

/** A stored cleanup (the persisted fields; geom is kept decoded as lat/lng). */
interface StoredCleanup {
  id: string
  organizerUserId: string
  type: CleanupRecord["type"]
  eventKind: EventKind
  title: string
  description: string | null
  lat: number
  lng: number
  scheduledAt: Date
  status: CleanupRecord["status"]
  bring: string[] | null
  address: string | null
  jurisdictionGeoid: string | null
  referenceCode: string | null
  createdAt: Date
}

/** A stored membership row (cleanup_members). */
interface StoredMember {
  cleanupId: string
  userId: string
  role: CleanupMemberRole
}

/** A stored ban row (cleanup_bans, M17): written by removeMember, checked by joinCleanupTx. */
interface StoredBan {
  cleanupId: string
  userId: string
  bannedByUserId: string
}

/** A stored user (the subset the organizer person join needs). */
interface StoredUser {
  id: string
  displayName: string
  handle: string | null
  bio: string | null
}

/** A stored report (the subset the link galleries + visibility filter need). */
interface StoredReport {
  id: string
  category: ReportCategory
  title: string | null
  status: ReportStatus
  visibility: "public" | "hidden"
  lat: number
  lng: number
  addr: string | null
  thumbKey: string | null
  deleted: boolean
}

/** A stored cleanup_reports junction row. */
interface StoredLink {
  cleanupId: string
  reportId: string
  linkedByUserId: string | null
  linkedAt: Date
}

/** A stored cleanup_slots row (P9). Identity is `id`; `sortOrder` is presentational only. */
interface StoredSlot {
  id: string
  cleanupId: string
  title: string
  description: string | null
  capacity: number | null
  sortOrder: number
}

/**
 * A stored cleanup_slot_claims row. The (cleanupId, userId) pair is the PK — modeled here by the
 * single-row lookup every writer below does before inserting, which is what the composite PK enforces
 * in the real schema ("one slot per person per event", so a move is an UPDATE and never a second row).
 */
interface StoredSlotClaim {
  cleanupId: string
  userId: string
  slotId: string
}

/**
 * Great-circle distance in metres between two lat/lng points (haversine). Used to mirror the Drizzle
 * impl's ST_Distance(geography) ordering for `near` listings closely enough for deterministic tests.
 */
export function haversineMeters(a: NearPoint, b: NearPoint): number {
  const R = 6371008.8 // mean Earth radius (m), matching PostGIS geography defaults closely.
  const toRad = (d: number): number => (d * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** An in-memory CleanupRepository faithful to the Drizzle impl's observable behavior. */
export class InMemoryCleanupRepository implements CleanupRepository {
  readonly cleanups = new Map<string, StoredCleanup>()
  readonly members: StoredMember[] = []
  /** cleanup_bans rows (M17), inspectable by tests. */
  readonly bans: StoredBan[] = []
  readonly users = new Map<string, StoredUser>()
  /** Follow edges as "<followerId>:<followeeId>" so listAttendees can resolve isFollowing. */
  readonly follows = new Set<string>()
  /** Reports seeded so the link galleries + the visibility filter resolve. */
  readonly reports = new Map<string, StoredReport>()
  /** cleanup_reports junction rows. */
  readonly links: StoredLink[] = []
  /** cleanup_slots rows (P9), inspectable by tests. */
  readonly slots: StoredSlot[] = []
  /** cleanup_slot_claims rows (P9), inspectable by tests. */
  readonly slotClaims: StoredSlotClaim[] = []
  /** cleanup_timeline rows appended by link/unlink/cancel/resource_request (kind + reportId + note +
   *  actor), inspectable by tests. `reportId` is "" for non-link rows; `note` carries free-text entries. */
  readonly timeline: {
    cleanupId: string
    kind: string
    reportId: string
    note: string | null
    actorId: string | null
  }[] = []

  /** Seedable geoid -> jurisdiction routing contact, mirroring jurisdiction_contacts (D19 event routing). */
  readonly jurisdictionContacts = new Map<string, { contact: string; name: string }>()

  /** Injectable clock so when-filters are deterministic. Defaults to real now. */
  now: () => Date = () => new Date()

  /** Per-scope EVENT reference-code counter ("EVENT:{jurcode}" -> next seq), mirroring reference_counters. */
  private readonly refCounters = new Map<string, number>()

  /** Allocate the next EVENT reference code for jurCode, mirroring allocateEventReferenceCode (D4/M8). */
  private allocateEventReferenceCode(jurCode: number): string {
    const scope = eventScopeKey(jurCode)
    const seq = (this.refCounters.get(scope) ?? 0) + 1
    this.refCounters.set(scope, seq)
    return formatReferenceCode(EVENT_PREFIX, jurCode, seq)
  }

  /** Test helper: seed a user so the organizer person join resolves. Returns the id. */
  seedUser(over: Partial<StoredUser> = {}): StoredUser {
    const user: StoredUser = {
      id: over.id ?? randomUUID(),
      displayName: over.displayName ?? "Organizer",
      handle: over.handle ?? null,
      bio: over.bio ?? null,
    }
    this.users.set(user.id, user)
    return user
  }

  /** Test helper: record that `followerId` follows `followeeId` (drives listAttendees' isFollowing). */
  seedFollow(followerId: string, followeeId: string): void {
    this.follows.add(`${followerId}:${followeeId}`)
  }

  /** Test helper: seed a membership row directly with an explicit role (default plain member). */
  seedMember(cleanupId: string, userId: string, role: CleanupMemberRole = "member"): void {
    if (!this.users.has(userId)) this.seedUser({ id: userId })
    const existing = this.members.find((m) => m.cleanupId === cleanupId && m.userId === userId)
    if (existing) existing.role = role
    else this.members.push({ cleanupId, userId, role })
  }

  /** Test helper: seed a report so the link galleries + visibility filter resolve. Defaults to visible. */
  seedReport(over: Partial<StoredReport> & { id?: string } = {}): StoredReport {
    const report: StoredReport = {
      id: over.id ?? randomUUID(),
      category: over.category ?? "trash",
      title: over.title ?? "Overflowing bin",
      status: over.status ?? "published",
      visibility: over.visibility ?? "public",
      lat: over.lat ?? 34.0,
      lng: over.lng ?? -118.49,
      addr: over.addr ?? null,
      thumbKey: over.thumbKey ?? null,
      deleted: over.deleted ?? false,
    }
    this.reports.set(report.id, report)
    return report
  }

  /** Test helper: seed a cleanup_reports link directly (bypassing the link path). */
  seedLink(cleanupId: string, reportId: string, linkedByUserId: string | null = null): void {
    this.links.push({ cleanupId, reportId, linkedByUserId, linkedAt: this.now() })
  }

  /**
   * True when a report is publicly visible - the exact mirror of publicReportFilter(): a status in
   * PUBLIC_REPORT_STATUSES (published AND the progress states acknowledged/in_progress/resolved), public
   * visibility, not soft-deleted.
   */
  private reportVisible(r: StoredReport | undefined): r is StoredReport {
    return (
      r !== undefined &&
      !r.deleted &&
      isPubliclyVisibleStatus(r.status) &&
      r.visibility === "public"
    )
  }

  /** Test helper: seed a cleanup directly (and optionally its organizer membership). */
  seedCleanup(over: Partial<StoredCleanup> & { id?: string }): StoredCleanup {
    const cleanup: StoredCleanup = {
      id: over.id ?? randomUUID(),
      organizerUserId: over.organizerUserId ?? randomUUID(),
      type: over.type ?? "site",
      eventKind: over.eventKind ?? "cleanup",
      title: over.title ?? "Beach cleanup",
      description: over.description ?? null,
      lat: over.lat ?? 34.0,
      lng: over.lng ?? -118.49,
      scheduledAt: over.scheduledAt ?? new Date(Date.now() + 86_400_000),
      status: over.status ?? "upcoming",
      bring: over.bring ?? null,
      address: over.address ?? null,
      jurisdictionGeoid: over.jurisdictionGeoid ?? null,
      referenceCode: over.referenceCode ?? null,
      createdAt: over.createdAt ?? new Date(),
    }
    this.cleanups.set(cleanup.id, cleanup)
    // Ensure the organizer person can be joined; seed a default user when absent.
    if (!this.users.has(cleanup.organizerUserId)) {
      this.seedUser({ id: cleanup.organizerUserId })
    }
    // The organizer is always a member (mirrors createCleanupTx).
    if (!this.members.some((m) => m.cleanupId === cleanup.id && m.userId === cleanup.organizerUserId)) {
      this.members.push({ cleanupId: cleanup.id, userId: cleanup.organizerUserId, role: "organizer" })
    }
    return cleanup
  }

  private personView(userId: string): CleanupPersonView {
    const u = this.users.get(userId)
    return {
      id: userId,
      displayName: u?.displayName ?? "Unknown",
      handle: u?.handle ?? null,
      bio: u?.bio ?? null,
    }
  }

  private memberCountOf(cleanupId: string): number {
    return this.members.filter((m) => m.cleanupId === cleanupId).length
  }

  private toRecord(c: StoredCleanup, near: NearPoint | null): CleanupRecord {
    return {
      id: c.id,
      organizerUserId: c.organizerUserId,
      type: c.type,
      eventKind: c.eventKind,
      title: c.title,
      description: c.description,
      lat: c.lat,
      lng: c.lng,
      scheduledAt: c.scheduledAt,
      status: c.status,
      bring: c.bring,
      address: c.address,
      jurisdictionGeoid: c.jurisdictionGeoid,
      referenceCode: c.referenceCode,
      createdAt: c.createdAt,
      going: this.memberCountOf(c.id),
      dist: near !== null ? haversineMeters(near, { lat: c.lat, lng: c.lng }) : null,
      organizer: this.personView(c.organizerUserId),
    }
  }

  createCleanupTx(args: CreateCleanupTxArgs): Promise<CleanupRecord> {
    // D4: allocate the EVENT reference code FIRST (mirrors the Drizzle create tx), keyed off the pre-tx
    // jurCode (0 = unknown bucket when no jurisdiction resolved).
    const referenceCode = this.allocateEventReferenceCode(args.jurCode)
    const cleanup: StoredCleanup = {
      id: args.cleanupId,
      organizerUserId: args.organizerUserId,
      type: args.type,
      eventKind: args.eventKind,
      title: args.title,
      description: args.description,
      lat: args.lat,
      lng: args.lng,
      scheduledAt: args.scheduledAt,
      status: args.status,
      bring: args.bring,
      address: args.address,
      jurisdictionGeoid: args.jurisdictionGeoid,
      referenceCode,
      createdAt: this.now(),
    }
    this.cleanups.set(cleanup.id, cleanup)
    // Auto-join the organizer atomically (same step as the row insert).
    this.members.push({ cleanupId: cleanup.id, userId: cleanup.organizerUserId, role: "organizer" })
    if (!this.users.has(cleanup.organizerUserId)) {
      this.seedUser({ id: cleanup.organizerUserId })
    }
    // Link the initial reports + record the 'report_linked' timeline rows (mirrors linkReportsInTx).
    this.linkInner(cleanup.id, args.linkedReportIds, args.organizerUserId)
    // B22: the create-time slot set lands in the same "transaction". Every entry inserts — the service
    // strips any client-supplied id before it reaches the repo, because on create nothing exists to edit.
    for (const slot of args.slots) this.insertSlot(cleanup.id, slot)
    return Promise.resolve(this.toRecord(cleanup, null))
  }

  /** Insert one cleanup_slots row (shared by create + reconcile). Returns the new id. */
  private insertSlot(cleanupId: string, slot: DesiredSlot): string {
    const id = randomUUID()
    this.slots.push({
      id,
      cleanupId,
      title: slot.title,
      description: slot.description,
      capacity: slot.capacity,
      sortOrder: slot.sortOrder,
    })
    return id
  }

  /** Test helper: seed a slot directly (bypassing create/reconcile). Returns the stored row. */
  seedSlot(over: Partial<StoredSlot> & { cleanupId: string }): StoredSlot {
    const slot: StoredSlot = {
      id: over.id ?? randomUUID(),
      cleanupId: over.cleanupId,
      title: over.title ?? "Registration table",
      description: over.description ?? null,
      capacity: over.capacity ?? null,
      sortOrder: over.sortOrder ?? 0,
    }
    this.slots.push(slot)
    return slot
  }

  findCleanupById(id: string, near: NearPoint | null): Promise<CleanupRecord | null> {
    const c = this.cleanups.get(id)
    return Promise.resolve(c ? this.toRecord(c, near) : null)
  }

  findCleanupByReferenceCode(code: string): Promise<CleanupRecord | null> {
    // Mirror the Drizzle by-code lookup (reference_code is unique). No distance (not a near listing).
    const c = [...this.cleanups.values()].find((x) => x.referenceCode === code)
    return Promise.resolve(c ? this.toRecord(c, null) : null)
  }

  /** Link the given ids (skip already-linked) + record a 'report_linked' timeline row each. Returns added. */
  private linkInner(cleanupId: string, reportIds: string[], actorId: string | null): string[] {
    const added: string[] = []
    for (const reportId of reportIds) {
      const exists = this.links.some((l) => l.cleanupId === cleanupId && l.reportId === reportId)
      if (exists) continue
      this.links.push({ cleanupId, reportId, linkedByUserId: actorId, linkedAt: this.now() })
      this.timeline.push({ cleanupId, kind: "report_linked", reportId, note: null, actorId })
      added.push(reportId)
    }
    return added
  }

  updateCleanup(id: string, patch: UpdateCleanupPatch): Promise<boolean> {
    const c = this.cleanups.get(id)
    if (!c) return Promise.resolve(false)
    if (patch.title !== undefined) c.title = patch.title
    if (patch.description !== undefined) c.description = patch.description
    if (patch.eventKind !== undefined) c.eventKind = patch.eventKind
    if (patch.type !== undefined) c.type = patch.type
    if (patch.scheduledAt !== undefined) c.scheduledAt = patch.scheduledAt
    if (patch.lat !== undefined && patch.lng !== undefined) {
      c.lat = patch.lat
      c.lng = patch.lng
    }
    if (patch.address !== undefined) c.address = patch.address
    if (patch.bring !== undefined) c.bring = patch.bring
    return Promise.resolve(true)
  }

  linkReports(cleanupId: string, reportIds: string[], actorId: string | null): Promise<string[]> {
    return Promise.resolve(this.linkInner(cleanupId, reportIds, actorId))
  }

  unlinkReport(cleanupId: string, reportId: string, actorId: string | null): Promise<boolean> {
    const idx = this.links.findIndex((l) => l.cleanupId === cleanupId && l.reportId === reportId)
    if (idx < 0) return Promise.resolve(false)
    this.links.splice(idx, 1)
    this.timeline.push({ cleanupId, kind: "report_unlinked", reportId, note: null, actorId })
    return Promise.resolve(true)
  }

  reconcileLinkedReports(
    cleanupId: string,
    desiredIds: string[],
    actorId: string | null,
  ): Promise<{ added: string[]; removed: string[] }> {
    const have = this.links.filter((l) => l.cleanupId === cleanupId).map((l) => l.reportId)
    const want = new Set(desiredIds)
    const toAdd = desiredIds.filter((id) => !have.includes(id))
    const toRemove = have.filter((id) => !want.has(id))
    const added = this.linkInner(cleanupId, toAdd, actorId)
    for (const reportId of toRemove) {
      const idx = this.links.findIndex((l) => l.cleanupId === cleanupId && l.reportId === reportId)
      if (idx >= 0) this.links.splice(idx, 1)
      this.timeline.push({ cleanupId, kind: "report_unlinked", reportId, note: null, actorId })
    }
    return Promise.resolve({ added, removed: toRemove })
  }

  loadLinkedReportsForCleanups(cleanupIds: string[]): Promise<Map<string, LinkedReportView[]>> {
    const ids = new Set(cleanupIds)
    const grouped = new Map<string, LinkedReportView[]>()
    // Newest links first (mirrors ORDER BY linked_at DESC).
    const ordered = [...this.links]
      .filter((l) => ids.has(l.cleanupId))
      .sort((a, b) => b.linkedAt.getTime() - a.linkedAt.getTime())
    for (const link of ordered) {
      const r = this.reports.get(link.reportId)
      // Only published+public, non-deleted reports leak into the gallery (held/hidden never).
      if (!this.reportVisible(r)) continue
      const view: LinkedReportView = {
        cleanupId: link.cleanupId,
        id: r.id,
        category: r.category,
        title: r.title,
        status: r.status,
        lat: r.lat,
        lng: r.lng,
        addr: r.addr,
        thumbKey: r.thumbKey,
        linkedAt: link.linkedAt,
      }
      const list = grouped.get(link.cleanupId)
      if (list) list.push(view)
      else grouped.set(link.cleanupId, [view])
    }
    return Promise.resolve(grouped)
  }

  loadLinkedEventsForReports(reportIds: string[]): Promise<Map<string, LinkedEventView[]>> {
    const ids = new Set(reportIds)
    const grouped = new Map<string, LinkedEventView[]>()
    const ordered = [...this.links]
      .filter((l) => ids.has(l.reportId))
      .sort((a, b) => b.linkedAt.getTime() - a.linkedAt.getTime())
    for (const link of ordered) {
      const c = this.cleanups.get(link.cleanupId)
      if (!c) continue
      const view: LinkedEventView = {
        reportId: link.reportId,
        id: c.id,
        title: c.title,
        eventKind: c.eventKind,
        status: c.status,
        scheduledAt: c.scheduledAt,
        lat: c.lat,
        lng: c.lng,
        going: this.memberCountOf(c.id),
        organizer: this.personView(c.organizerUserId),
        linkedAt: link.linkedAt,
      }
      const list = grouped.get(link.reportId)
      if (list) list.push(view)
      else grouped.set(link.reportId, [view])
    }
    return Promise.resolve(grouped)
  }

  filterVisibleReportIds(reportIds: string[]): Promise<Set<string>> {
    const visible = new Set(
      reportIds.filter((id) => this.reportVisible(this.reports.get(id))),
    )
    return Promise.resolve(visible)
  }

  listCleanups(
    filters: ListCleanupsFilters,
  ): Promise<{ records: CleanupRecord[]; nextCursor: string | null }> {
    const nowMs = this.now().getTime()
    const near = filters.near ?? null

    const inBox = (c: StoredCleanup, bbox: CleanupBBox): boolean =>
      c.lng >= bbox.west && c.lng <= bbox.east && c.lat >= bbox.south && c.lat <= bbox.north

    let all = [...this.cleanups.values()].filter((c) => {
      // when filter (mirrors buildWhenFilter): "attending" shares the upcoming time window.
      if (filters.when === "upcoming" || filters.when === "attending") {
        if (!(c.scheduledAt.getTime() >= nowMs && c.status !== "cancelled")) return false
      } else if (filters.when === "past") {
        if (!(c.scheduledAt.getTime() < nowMs)) return false
      } else if (c.status === "cancelled") {
        return false
      }
      // attending: keep only events the viewer is a member of (mirrors buildMembershipFilter). A null
      // viewer matches nothing, so an anonymous "attending" list is empty.
      if (filters.when === "attending") {
        const viewerId = filters.viewerId ?? null
        if (viewerId === null || !this.members.some((m) => m.cleanupId === c.id && m.userId === viewerId))
          return false
      }
      // bbox filter.
      if (filters.bbox !== undefined && !inBox(c, filters.bbox)) return false
      return true
    })

    if (near !== null) {
      // Order by distance ASC, id ASC; keyset cursor `${dist}|${id}`.
      const withDist = all
        .map((c) => ({ c, dist: haversineMeters(near, { lat: c.lat, lng: c.lng }) }))
        .sort((a, b) => (a.dist !== b.dist ? a.dist - b.dist : a.c.id < b.c.id ? -1 : 1))
      const cursor = parseNearCursor(filters.cursor)
      const after =
        cursor !== null
          ? withDist.filter(
              (x) => x.dist > cursor.dist || (x.dist === cursor.dist && x.c.id > cursor.id),
            )
          : withDist
      // Same split + encoder as the Drizzle near branch.
      const { items, nextCursor } = pageWith(after, filters.limit, (last) =>
        encodeNearCursor({ dist: last.dist, id: last.c.id }),
      )
      const records = items.map((x) => this.toRecord(x.c, near))
      return Promise.resolve({ records, nextCursor })
    }

    // Non-near: order by scheduled_at (DESC for past, else ASC), id tiebreak; cursor `${iso}|${id}`.
    const past = filters.when === "past"
    all = all.sort((a, b) => {
      const cmp = a.scheduledAt.getTime() - b.scheduledAt.getTime()
      if (cmp !== 0) return past ? -cmp : cmp
      const idCmp = a.id < b.id ? -1 : a.id > b.id ? 1 : 0
      return past ? -idCmp : idCmp
    })
    const cursor = parseTimeCursor(filters.cursor)
    const after =
      cursor !== null
        ? all.filter((c) => {
            const t = c.scheduledAt.getTime()
            const ct = cursor.at.getTime()
            if (past) return t < ct || (t === ct && c.id < cursor.id)
            return t > ct || (t === ct && c.id > cursor.id)
          })
        : all
    // Same split + encoder as the Drizzle when branch (scheduled_at anchors both directions).
    const { items, nextCursor } = pageWith(after, filters.limit, (last) =>
      encodeTimeCursor({ at: last.scheduledAt, id: last.id }),
    )
    const records = items.map((c) => this.toRecord(c, null))
    return Promise.resolve({ records, nextCursor })
  }

  isMember(cleanupId: string, userId: string): Promise<boolean> {
    return Promise.resolve(
      this.members.some((m) => m.cleanupId === cleanupId && m.userId === userId),
    )
  }

  roleOf(cleanupId: string, userId: string): Promise<CleanupMemberRole | null> {
    const m = this.members.find((x) => x.cleanupId === cleanupId && x.userId === userId)
    return Promise.resolve(m?.role ?? null)
  }

  rolesOf(cleanupIds: string[], userId: string): Promise<Map<string, CleanupMemberRole>> {
    const ids = new Set(cleanupIds)
    const roles = new Map<string, CleanupMemberRole>()
    for (const m of this.members) {
      if (m.userId === userId && ids.has(m.cleanupId)) roles.set(m.cleanupId, m.role)
    }
    return Promise.resolve(roles)
  }

  setMemberRole(cleanupId: string, userId: string, role: "cohost" | "member"): Promise<boolean> {
    // Mirrors the Drizzle UPDATE's `role <> 'organizer'` defense-in-depth guard.
    const m = this.members.find((x) => x.cleanupId === cleanupId && x.userId === userId)
    if (!m || m.role === "organizer") return Promise.resolve(false)
    m.role = role
    return Promise.resolve(true)
  }

  // M17: removal writes a ban row in the SAME operation as the membership delete (the Drizzle impl
  // does both in one transaction), which is what makes it stick against the self-service join.
  removeMember(
    cleanupId: string,
    userId: string,
    actorId: string,
  ): Promise<{ removed: boolean; going: number }> {
    const idx = this.members.findIndex(
      (m) => m.cleanupId === cleanupId && m.userId === userId && m.role !== "organizer",
    )
    if (idx >= 0) {
      this.members.splice(idx, 1)
      if (!this.bans.some((b) => b.cleanupId === cleanupId && b.userId === userId)) {
        this.bans.push({ cleanupId, userId, bannedByUserId: actorId })
      }
      // B28d: the claim dies with the membership, in the same operation the Drizzle impl does both in.
      // A removed attendee who kept their seat would leave a phantom-full slot nobody can free.
      this.deleteClaim(cleanupId, userId)
    }
    return Promise.resolve({ removed: idx >= 0, going: this.memberCountOf(cleanupId) })
  }

  isBanned(cleanupId: string, userId: string): Promise<boolean> {
    return Promise.resolve(this.bans.some((b) => b.cleanupId === cleanupId && b.userId === userId))
  }

  unbanMember(cleanupId: string, userId: string): Promise<boolean> {
    const idx = this.bans.findIndex((b) => b.cleanupId === cleanupId && b.userId === userId)
    if (idx >= 0) this.bans.splice(idx, 1)
    return Promise.resolve(idx >= 0)
  }

  listMemberIds(cleanupId: string, limit: number): Promise<string[]> {
    // Insertion order mirrors the Drizzle impl's joined_at ASC (members are appended in join order).
    const ids = this.members
      .filter((m) => m.cleanupId === cleanupId)
      .map((m) => m.userId)
      .slice(0, limit)
    return Promise.resolve(ids)
  }

  memberCount(cleanupId: string): Promise<number> {
    return Promise.resolve(this.memberCountOf(cleanupId))
  }

  organizerOf(cleanupId: string): Promise<string | null> {
    const c = this.cleanups.get(cleanupId)
    return Promise.resolve(c ? c.organizerUserId : null)
  }

  joinCleanupTx(cleanupId: string, userId: string): Promise<"joined" | "not_found" | "banned"> {
    if (!this.cleanups.has(cleanupId)) return Promise.resolve("not_found")
    // M17: a removed attendee cannot re-join themselves.
    if (this.bans.some((b) => b.cleanupId === cleanupId && b.userId === userId)) {
      return Promise.resolve("banned")
    }
    if (!this.members.some((m) => m.cleanupId === cleanupId && m.userId === userId)) {
      this.members.push({ cleanupId, userId, role: "member" })
    }
    return Promise.resolve("joined")
  }

  leaveCleanup(cleanupId: string, userId: string): Promise<boolean> {
    if (!this.cleanups.has(cleanupId)) return Promise.resolve(false)
    const idx = this.members.findIndex((m) => m.cleanupId === cleanupId && m.userId === userId)
    if (idx >= 0) this.members.splice(idx, 1)
    // B28d: leaving frees the seat too — the Drizzle twin deletes both rows in one transaction.
    this.deleteClaim(cleanupId, userId)
    return Promise.resolve(true)
  }

  /** Delete the (cleanupId, userId) claim row if present. Returns the freed slot id, or null. */
  private deleteClaim(cleanupId: string, userId: string): string | null {
    const idx = this.slotClaims.findIndex(
      (c) => c.cleanupId === cleanupId && c.userId === userId,
    )
    if (idx < 0) return null
    const [claim] = this.slotClaims.splice(idx, 1)
    return claim?.slotId ?? null
  }

  cancelCleanupTx(
    id: string,
    input: { note: string; body: string; reason: string | null; actorId: string },
  ): Promise<CancelCleanupOutcome> {
    const c = this.cleanups.get(id)
    // No such cleanup: the service turns this into a 404 (distinct from a legal repeat cancel).
    if (!c) return Promise.resolve("not_found")
    // Mirrors the Drizzle impl's guarded
    // `UPDATE ... WHERE id = $1 AND status <> 'cancelled' AND status <> 'done'`: exactly one caller can
    // make the upcoming->cancelled transition, so only that caller is told "cancelled".
    // Re-cancelling is a legal no-op that still returns the DTO — but it writes NO second timeline row
    // and earns NO second attendee bell, which is why the outcome has to be observable here.
    if (c.status === "cancelled") return Promise.resolve("already_cancelled")
    // B18: a COMPLETED event refuses the cancel outright (the service 409s) — completion is forward-only
    // and a cancelled event carrying credited volunteer_hours rows is uninterpretable.
    if (c.status === "done") return Promise.resolve("already_completed")
    c.status = "cancelled"
    // Mirror the Drizzle impl's observable timeline write so a service test can assert the 'cancel' row.
    // The notification fan-out is NOT modeled here — post-L24 it no longer lives in the repo at all: the
    // service fans it out through NotificationService after this transaction commits (see
    // cleanup-service.notifyCancellation), so tests observe bells through the notifier, not the fake.
    this.timeline.push({ cleanupId: id, kind: "cancel", reportId: "", note: input.note, actorId: input.actorId })
    return Promise.resolve("cancelled")
  }

  // B16's twin: the same lock-then-branch matrix the Drizzle impl runs, minus the lock (a single-threaded
  // fake serializes by construction). The ORDER of the branches is load-bearing and must match the SQL:
  // cancelled before done before the time gate, so a cancelled event never reports "too_early" and an
  // already-done one is never re-time-gated by a scheduled_at a later edit moved into the future.
  completeCleanupTx(
    id: string,
    input: { note: string; actorId: string; now: Date },
  ): Promise<CompleteCleanupOutcome> {
    const c = this.cleanups.get(id)
    if (!c) return Promise.resolve("not_found")
    if (c.status === "cancelled") return Promise.resolve("cancelled")
    // Idempotent repeat: NO second timeline row (the assertion the unit suite makes).
    if (c.status === "done") return Promise.resolve("already_completed")
    if (c.scheduledAt.getTime() > input.now.getTime()) return Promise.resolve("too_early")
    c.status = "done"
    // Mirror the Drizzle impl's observable timeline write (kind 'status', the free-text kind the admin
    // setStatus path already uses) so a service test can assert the row and its composed note.
    this.timeline.push({
      cleanupId: id,
      kind: "status",
      reportId: "",
      note: input.note,
      actorId: input.actorId,
    })
    return Promise.resolve("completed")
  }

  listAttendees(args: ListAttendeesArgs): Promise<AttendeeView[]> {
    const { cleanupId, viewerId, onlyFollowed, limit } = args
    const follows = (userId: string): boolean =>
      viewerId !== null && this.follows.has(`${viewerId}:${userId}`)

    // Members of this cleanup, organizer-first then cohosts then insertion order (mirrors the Drizzle
    // ORDER BY (role='organizer') DESC, (role='cohost') DESC, joined_at ASC, since members are appended
    // in join order).
    const rank = (role: CleanupMemberRole): number =>
      role === "organizer" ? 0 : role === "cohost" ? 1 : 2
    const ordered = this.members
      .map((m, idx) => ({ m, idx }))
      .filter((x) => x.m.cleanupId === cleanupId)
      .sort((a, b) => {
        const cmp = rank(a.m.role) - rank(b.m.role)
        if (cmp !== 0) return cmp
        return a.idx - b.idx
      })

    let views: AttendeeView[] = ordered.map((x) => {
      const view = this.personView(x.m.userId)
      // B29b: the roster carries each attendee's claimed slot (or null) — the Drizzle twin's two LEFT
      // JOINs. This is the whole "per-slot roster" feature; there is no second endpoint.
      const claim = this.slotClaims.find(
        (c) => c.cleanupId === cleanupId && c.userId === x.m.userId,
      )
      const slot = claim ? this.slots.find((s) => s.id === claim.slotId) : undefined
      return {
        ...view,
        isFollowing: follows(x.m.userId),
        role: x.m.role,
        slot: slot ? { id: slot.id, title: slot.title } : null,
      }
    })
    if (onlyFollowed) views = views.filter((v) => v.isFollowing)
    return Promise.resolve(views.slice(0, limit))
  }

  // ---------------------------------------------------------------------------------------------
  // P9 signup slots. The unit suite is the ONLY place these rules run without Docker, so the twin
  // models every one of them: the capacity check, the one-slot-per-person PK, the auto-RSVP, the
  // closed-event refusal, the composite-FK rejection of a foreign slotId, and the leave/remove cleanup.
  // ---------------------------------------------------------------------------------------------

  /** Ordered slot board for one cleanup + the viewer's own claim per row (mirrors the batched SQL). */
  private slotViews(cleanupId: string, viewerId: string | null): EventSlotView[] {
    return this.slots
      .filter((s) => s.cleanupId === cleanupId)
      .sort((a, b) => (a.sortOrder !== b.sortOrder ? a.sortOrder - b.sortOrder : a.id < b.id ? -1 : 1))
      .map((s) => ({
        cleanupId: s.cleanupId,
        id: s.id,
        title: s.title,
        description: s.description,
        capacity: s.capacity,
        sortOrder: s.sortOrder,
        claimed: this.slotClaims.filter((c) => c.slotId === s.id).length,
        // A null viewerId makes `mine` false for every row — the SQL gets the same answer from the NULL
        // comparison, not from a special case.
        mine: viewerId !== null
          && this.slotClaims.some((c) => c.slotId === s.id && c.userId === viewerId),
      }))
  }

  listSlots(cleanupId: string, viewerId: string | null): Promise<EventSlotView[]> {
    return Promise.resolve(this.slotViews(cleanupId, viewerId))
  }

  loadSlotsForCleanups(
    cleanupIds: string[],
    viewerId: string | null,
  ): Promise<Map<string, EventSlotView[]>> {
    const grouped = new Map<string, EventSlotView[]>()
    for (const cleanupId of cleanupIds) {
      const views = this.slotViews(cleanupId, viewerId)
      if (views.length > 0) grouped.set(cleanupId, views)
    }
    return Promise.resolve(grouped)
  }

  slotCountsFor(cleanupIds: string[]): Promise<Map<string, number>> {
    const ids = new Set(cleanupIds)
    const counts = new Map<string, number>()
    for (const s of this.slots) {
      if (!ids.has(s.cleanupId)) continue
      counts.set(s.cleanupId, (counts.get(s.cleanupId) ?? 0) + 1)
    }
    return Promise.resolve(counts)
  }

  reconcileSlots(
    cleanupId: string,
    desired: DesiredSlot[],
    actorId: string | null,
  ): Promise<SlotReconcileResult> {
    const have = this.slots.filter((s) => s.cleanupId === cleanupId)
    const haveIds = new Set(have.map((s) => s.id))

    // B23: an id NOT on THIS cleanup is a hard 422 — never a silent insert, never a quiet re-parent.
    // Checked before ANY mutation so the reconcile is all-or-nothing, exactly like the SQL transaction.
    for (const slot of desired) {
      if (slot.id !== undefined && !haveIds.has(slot.id)) {
        throw AppError.validation({ slots: `unknown slot: ${slot.id}` })
      }
    }

    // cleanup_slots_cleanup_title_uidx (cleanup_id, lower(title)), mirrored. `desired` IS the full
    // final board, so after the drizzle repo's DELETE-first + park-the-renames ordering the ONLY
    // collision it can still raise is a duplicate WITHIN this set — which it catches as a 23505 and
    // rethrows as exactly this named 422. Without this the twin would happily build a board the real
    // database refuses.
    const seenTitles = new Set<string>()
    for (const slot of desired) {
      const key = slot.title.toLowerCase()
      if (seenTitles.has(key)) throw AppError.validation({ slots: "duplicate slot title" })
      seenTitles.add(key)
    }

    // REMOVALS FIRST, exactly like the SQL: the unique index above is checked immediately, so a save
    // that removes "Grill" and adds a new "Grill" only works if the old row is gone before the new one
    // lands. (The rename-parking half of the SQL has no twin: nothing here holds an index.)
    const keep = new Set(desired.map((s) => s.id).filter((id): id is string => id !== undefined))
    const removed: SlotReconcileResult["removed"] = []
    for (const row of have) {
      if (keep.has(row.id)) continue
      // The claimants are read BEFORE the delete — after it, the cascade has taken the claim rows and
      // there is nobody left to ring (B34).
      const claimantUserIds = this.slotClaims
        .filter((c) => c.slotId === row.id)
        .map((c) => c.userId)
        .filter((u) => u !== actorId)
      // B24: dropping a claimed slot drops its claimants. Allowed — the bell is the mitigation. (The
      // real schema does it with ON DELETE CASCADE on the composite FK.)
      for (let i = this.slotClaims.length - 1; i >= 0; i--) {
        if (this.slotClaims[i]!.slotId === row.id) this.slotClaims.splice(i, 1)
      }
      const idx = this.slots.findIndex((s) => s.id === row.id)
      if (idx >= 0) this.slots.splice(idx, 1)
      removed.push({ slotId: row.id, title: row.title, claimantUserIds })
    }

    const added: string[] = []
    const updated: string[] = []
    for (const slot of desired) {
      if (slot.id !== undefined) {
        const row = this.slots.find((s) => s.id === slot.id && s.cleanupId === cleanupId)
        if (row) {
          row.title = slot.title
          row.description = slot.description
          row.capacity = slot.capacity
          row.sortOrder = slot.sortOrder
          updated.push(row.id)
        }
      } else {
        added.push(this.insertSlot(cleanupId, slot))
      }
    }
    return Promise.resolve({ added, updated, removed })
  }

  claimSlot(cleanupId: string, userId: string, slotId: string): Promise<ClaimSlotOutcome> {
    // The branch ORDER mirrors the SQL statement order in claimSlot, and it is load-bearing: the ban
    // probe must precede the auto-RSVP (or a removed user re-enters through the slot door), the
    // already-holds check must precede the capacity check (or an idempotent re-claim 409s on a full
    // slot the user is already in), and the auto-RSVP must come AFTER both the slot lookup and the
    // capacity check — every refusal in the SQL is a normal return, which COMMITS, so a
    // `slot_not_found`/`full` outcome that had already written the membership row would make a
    // non-member into an attendee (roster, `going`, event group chat) behind a 404/409.
    const cleanup = this.cleanups.get(cleanupId)
    if (!cleanup) return Promise.resolve({ kind: "not_found" })
    // B28e: a completed/cancelled event's roster is what hours were attested against, and the auto-RSVP
    // below would otherwise hand membership to anyone claiming after the fact.
    if (cleanup.status === "done" || cleanup.status === "cancelled") {
      return Promise.resolve({ kind: "closed" })
    }
    if (this.bans.some((b) => b.cleanupId === cleanupId && b.userId === userId)) {
      return Promise.resolve({ kind: "banned" })
    }

    const current = this.slotClaims.find((c) => c.cleanupId === cleanupId && c.userId === userId)
    // The composite FK (slot_id, cleanup_id) makes a slot from ANOTHER event structurally unclaimable;
    // here that is the `s.cleanupId === cleanupId` half of the lookup.
    const slot = this.slots.find((s) => s.id === slotId && s.cleanupId === cleanupId)
    if (!slot) return Promise.resolve({ kind: "slot_not_found" })

    // Idempotent re-claim: no capacity check (see above).
    if (current?.slotId === slotId) return Promise.resolve({ kind: "claimed", slotId })

    if (slot.capacity !== null) {
      const claimed = this.slotClaims.filter((c) => c.slotId === slotId).length
      if (claimed >= slot.capacity) return Promise.resolve({ kind: "full" })
    }
    // B28b: picking a shift IS an RSVP — written only once this claim is actually going to be seated.
    if (!this.members.some((m) => m.cleanupId === cleanupId && m.userId === userId)) {
      this.members.push({ cleanupId, userId, role: "member" })
      if (!this.users.has(userId)) this.seedUser({ id: userId })
    }
    // The (cleanupId, userId) PK: a MOVE overwrites slot_id and frees the old seat in the same step,
    // never a second row.
    if (current) current.slotId = slotId
    else this.slotClaims.push({ cleanupId, userId, slotId })
    return Promise.resolve({ kind: "claimed", slotId })
  }

  releaseSlot(cleanupId: string, userId: string): Promise<ClaimSlotOutcome> {
    const cleanup = this.cleanups.get(cleanupId)
    if (!cleanup) return Promise.resolve({ kind: "not_found" })
    if (cleanup.status === "done" || cleanup.status === "cancelled") {
      return Promise.resolve({ kind: "closed" })
    }
    this.deleteClaim(cleanupId, userId)
    // Idempotent (B28c) — and releasing does NOT leave the event: the membership row is untouched.
    return Promise.resolve({ kind: "released" })
  }

  slotOf(cleanupId: string, userId: string): Promise<string | null> {
    const claim = this.slotClaims.find((c) => c.cleanupId === cleanupId && c.userId === userId)
    return Promise.resolve(claim?.slotId ?? null)
  }

  resolveJurisdictionContact(
    geoid: string | null,
  ): Promise<{ contact: string; name: string } | null> {
    if (geoid === null) return Promise.resolve(null)
    return Promise.resolve(this.jurisdictionContacts.get(geoid) ?? null)
  }

  appendCleanupTimeline(
    cleanupId: string,
    input: { kind: string; note: string | null; actorId: string | null },
  ): Promise<void> {
    this.timeline.push({
      cleanupId,
      kind: input.kind,
      reportId: "",
      note: input.note,
      actorId: input.actorId,
    })
    return Promise.resolve()
  }
}

