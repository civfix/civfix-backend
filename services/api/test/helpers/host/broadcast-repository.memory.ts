import { randomUUID } from "node:crypto"
import { ANNOUNCEMENT_BROADCAST_KIND } from "@civfix/shared"
import type { BroadcastKind, BroadcastStatus } from "@civfix/shared"
import type {
  AdminBroadcastListQuery,
  AnnouncementCap,
  AnnouncementListQuery,
  AudienceCountQuery,
  AudiencePageQuery,
  BroadcastListQuery,
  BroadcastRepository,
  DeliveryListQuery,
  DeliveryListRow,
  KeysetRow,
} from "../../../src/services/host/broadcast-repository.js"
import { DEFAULT_PREFS } from "../../../src/services/notification-helpers.js"
import type { NotificationPrefsRecord } from "../../../src/services/notification-repository.js"
import type { WriteAuditInput } from "../../../src/services/admin/audit.js"
import type { KeysetCursor } from "../../../src/db/cursor-helpers.js"
import type {
  AdminBroadcastRow,
  AdminHostListParams,
  AdminHostRow,
  BroadcastCreateInput,
  BroadcastDraftPatch,
  BroadcastRecord,
  DeliveryClaim,
  DeliveryCounts,
  DeliveryOutcome,
  DeliveryRowInput,
  DueReminder,
  EventBroadcastContext,
  GuestContact,
  HostMessagingState,
  MemberContact,
} from "../../../src/services/host/broadcast-types.js"
import {
  ANNOUNCEMENT_VISIBLE_STATUSES,
  CRITICAL_BROADCAST_KINDS,
  DEFAULT_BROADCAST_CHUNK_SIZE,
  HOST_COMPOSED_BROADCAST_KINDS,
} from "../../../src/services/host/broadcast-types.js"

type AudienceScopeQuery = Pick<AudiencePageQuery, "cleanupId" | "segment" | "kind">

interface DeliveryRow extends DeliveryRowInput {
  id: string
  status: string
  suppressionReason: string | null
  failureKind: string | null
  providerMessageId: string | null
  attempts: number
  sentAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export interface MemoryMember {
  userId: string
  ticketTypeId?: string | null
  ticketTypeName?: string | null
  slotId?: string | null
  waitlisted?: boolean
  checkedIn?: boolean
  registered?: boolean
  banned?: boolean
  deleted?: boolean
  suspended?: boolean
  hostBroadcastsPref?: boolean
  pushPref?: boolean
  quietHours?: { start: string; end: string; tz: string }
  contact?: Partial<MemberContact>
}

export interface MemoryGuest {
  guestId: string
  ticketTypeId?: string | null
  ticketTypeName?: string | null
  waitlisted?: boolean
  checkedIn?: boolean
  registered?: boolean
  cancelled?: boolean
  scrubbed?: boolean
  email?: string | null
  name?: string
}

interface Keyed {
  createdAt: Date
  id: string
}

function isBeforeCursor(row: Keyed, cursor: KeysetCursor | null): boolean {
  if (cursor === null) return true
  const at = row.createdAt.getTime()
  const cursorAt = cursor.at.getTime()
  return at < cursorAt || (at === cursorAt && row.id < cursor.id)
}

function newestFirst(a: Keyed, b: Keyed): number {
  return b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1)
}

function withCursorAt<T extends Keyed>(row: T): KeysetRow<T> {
  return { ...row, cursorAt: row.createdAt.toISOString() }
}

function isOpenDelivery(row: DeliveryRow): boolean {
  return row.status === "pending" || row.status === "in_flight"
}

function deliveryKey(row: DeliveryRowInput): string {
  return `${row.broadcastId}|${row.channel}|${row.recipientKind}|${row.userId ?? row.guestId ?? ""}`
}

function unsubscribeKey(
  scope: "event" | "global",
  cleanupId: string | null,
  subjectKind: "user" | "guest",
  subjectId: string,
): string {
  return `${scope}|${cleanupId ?? ""}|${subjectKind}|${subjectId}`
}

function muteKey(cleanupId: string, userId: string): string {
  return `${cleanupId}|${userId}`
}

export class InMemoryBroadcastRepository implements BroadcastRepository {
  private readonly broadcasts = new Map<string, BroadcastRecord>()
  private readonly deliveries = new Map<string, DeliveryRow>()
  private readonly unsubscribes = new Set<string>()
  private readonly mutes = new Set<string>()
  private readonly suppressedEmails = new Map<string, string>()
  private readonly members = new Map<string, MemoryMember[]>()
  private readonly guests = new Map<string, MemoryGuest[]>()
  private readonly events = new Map<string, EventBroadcastContext>()
  private readonly hosts = new Map<string, HostMessagingState>()
  private readonly deletedHosts = new Set<string>()
  private dueReminders: DueReminder[] = []
  readonly audits: WriteAuditInput[] = []

  seedEvent(
    context: Omit<EventBroadcastContext, "organizationSuspended"> & {
      organizationSuspended?: boolean
    },
  ): void {
    this.events.set(context.cleanupId, {
      ...context,
      organizationSuspended: context.organizationSuspended ?? false,
    })
  }

  /** Flip the org-suspension flag on a seeded event (what adminSetOrgSuspended does to its linked events). */
  setEventOrganizationSuspended(cleanupId: string, suspended: boolean): void {
    const existing = this.events.get(cleanupId)
    if (existing === undefined) throw new Error(`no seeded event ${cleanupId}`)
    this.events.set(cleanupId, { ...existing, organizationSuspended: suspended })
  }

  seedHost(userId: string, state: Partial<HostMessagingState> = {}): void {
    this.hosts.set(userId, {
      suspended: state.suspended ?? false,
      emailVerified: state.emailVerified ?? true,
      accountCreatedAt: state.accountCreatedAt ?? new Date(0),
    })
  }

  /** Mirrors a soft-deleted users row: the SQL reads and upserts filter `deleted_at IS NULL`. */
  softDeleteHost(userId: string): void {
    this.deletedHosts.add(userId)
  }

  seedMembers(cleanupId: string, rows: readonly MemoryMember[]): void {
    this.members.set(
      cleanupId,
      rows.map((row) => ({ registered: true, ...row })),
    )
  }

  seedGuests(cleanupId: string, rows: readonly MemoryGuest[]): void {
    this.guests.set(
      cleanupId,
      rows.map((row) => ({ registered: true, ...row })),
    )
  }

  forceCreatedAt(broadcastId: string, at: Date): void {
    const found = this.broadcasts.get(broadcastId)
    if (found === undefined) return
    this.broadcasts.set(broadcastId, { ...found, createdAt: at })
  }

  forceUpdatedAt(broadcastId: string, at: Date): void {
    const found = this.broadcasts.get(broadcastId)
    if (found === undefined) return
    this.broadcasts.set(broadcastId, { ...found, updatedAt: at })
  }

  seedDueReminders(rows: readonly DueReminder[]): void {
    this.dueReminders = [...rows]
  }

  allDeliveries(): DeliveryRow[] {
    return [...this.deliveries.values()]
  }

  create(input: BroadcastCreateInput): Promise<BroadcastRecord> {
    const now = new Date()
    const record: BroadcastRecord = {
      id: randomUUID(),
      cleanupId: input.cleanupId,
      createdBy: input.createdBy,
      kind: input.kind,
      reminderOffsetMin: input.reminderOffsetMin ?? null,
      status: input.status ?? "draft",
      subject: input.subject,
      bodyMd: input.bodyMd,
      ctaLabel: input.ctaLabel ?? null,
      ctaUrl: input.ctaUrl ?? null,
      segment: input.segment,
      channels: [...input.channels],
      replyTo: input.replyTo ?? null,
      scheduledAt: input.scheduledAt ?? null,
      plannedAt: null,
      startedAt: input.startedAt ?? null,
      finishedAt: null,
      chunkSize: input.chunkSize ?? DEFAULT_BROADCAST_CHUNK_SIZE,
      chunkCount: 0,
      recipientCount: 0,
      sentCount: 0,
      failedCount: 0,
      suppressedCount: 0,
      contentScrubbedAt: null,
      createdAt: now,
      updatedAt: now,
    }
    this.broadcasts.set(record.id, record)
    return Promise.resolve(record)
  }

  createAnnouncementUnderCap(
    input: BroadcastCreateInput,
    cap: AnnouncementCap,
  ): Promise<BroadcastRecord | null> {
    const used = [...this.broadcasts.values()].filter(
      (b) =>
        b.cleanupId === input.cleanupId &&
        b.kind === ANNOUNCEMENT_BROADCAST_KIND &&
        b.createdAt.getTime() >= cap.since.getTime(),
    ).length
    if (used >= cap.max) return Promise.resolve(null)
    return this.create(input)
  }

  async createIfAbsent(input: BroadcastCreateInput): Promise<BroadcastRecord | null> {
    const exists = [...this.broadcasts.values()].some((b) => {
      if (b.cleanupId !== input.cleanupId || b.kind !== input.kind) return false
      if (input.kind === "event_cancelled") return true
      return input.kind === "reminder" && b.reminderOffsetMin === (input.reminderOffsetMin ?? null)
    })
    if (exists) return null
    return this.create(input)
  }

  findById(broadcastId: string): Promise<BroadcastRecord | null> {
    return Promise.resolve(this.broadcasts.get(broadcastId) ?? null)
  }

  findForEvent(cleanupId: string, broadcastId: string): Promise<BroadcastRecord | null> {
    const found = this.broadcasts.get(broadcastId)
    return Promise.resolve(found && found.cleanupId === cleanupId ? found : null)
  }

  findEventCancellation(cleanupId: string): Promise<BroadcastRecord | null> {
    const found = [...this.broadcasts.values()].find(
      (b) => b.cleanupId === cleanupId && b.kind === "event_cancelled",
    )
    return Promise.resolve(found ?? null)
  }

  list(query: BroadcastListQuery): Promise<KeysetRow<BroadcastRecord>[]> {
    const rows = [...this.broadcasts.values()]
      .filter((b) => b.cleanupId === query.cleanupId)
      .filter((b) => query.status === undefined || b.status === query.status)
      .filter((b) => isBeforeCursor(b, query.cursor))
      .sort(newestFirst)
    return Promise.resolve(rows.slice(0, query.limit).map(withCursorAt))
  }

  listAnnouncements(query: AnnouncementListQuery): Promise<KeysetRow<BroadcastRecord>[]> {
    const rows = [...this.broadcasts.values()]
      .filter((b) => b.cleanupId === query.cleanupId)
      .filter((b) => b.kind === ANNOUNCEMENT_BROADCAST_KIND)
      .filter((b) => ANNOUNCEMENT_VISIBLE_STATUSES.includes(b.status))
      .filter((b) => isBeforeCursor(b, query.cursor))
      .sort(newestFirst)
    return Promise.resolve(rows.slice(0, query.limit).map(withCursorAt))
  }

  countAnnouncementsSince(cleanupId: string, since: Date): Promise<number> {
    const rows = [...this.broadcasts.values()].filter(
      (b) =>
        b.cleanupId === cleanupId &&
        b.kind === ANNOUNCEMENT_BROADCAST_KIND &&
        b.status !== "draft" &&
        b.createdAt.getTime() >= since.getTime(),
    )
    return Promise.resolve(rows.length)
  }

  listAdmin(query: AdminBroadcastListQuery): Promise<KeysetRow<AdminBroadcastRow>[]> {
    const rows = [...this.broadcasts.values()]
      .filter((b) => query.status === undefined || b.status === query.status)
      .filter((b) => query.kind === undefined || b.kind === query.kind)
      .filter((b) => query.cleanupId === undefined || b.cleanupId === query.cleanupId)
      .filter((b) => query.createdBy === undefined || b.createdBy === query.createdBy)
      .filter((b) => query.from === undefined || b.createdAt >= query.from)
      .filter((b) => query.to === undefined || b.createdAt <= query.to)
      .filter((b) => isBeforeCursor(b, query.cursor))
      .sort(newestFirst)
      .slice(0, query.limit)
      .map((b) => ({
        ...withCursorAt(b),
        eventTitle: this.events.get(b.cleanupId)?.title ?? null,
        createdByName: null,
        createdByHandle: null,
        createdByJoined: null,
      }))
    return Promise.resolve(rows)
  }

  listAdminHosts(params: AdminHostListParams): Promise<KeysetRow<AdminHostRow>[]> {
    const byUser = new Map<string, AdminHostRow>()
    const blank = (userId: string): AdminHostRow => ({
      userId,
      displayName: userId,
      handle: null,
      joinedAt: null,
      messagingSuspended: this.hosts.get(userId)?.suspended ?? false,
      suspendedAt: null,
      suspendedById: null,
      suspendedByName: null,
      suspendedByHandle: null,
      suspendedByJoined: null,
      broadcastCount: 0,
      recipientCount: 0,
      sentCount: 0,
      failedCount: 0,
      suppressedCount: 0,
      eventsMessaged: 0,
      lastBroadcastAt: null,
    })
    for (const b of this.broadcasts.values()) {
      if (b.createdBy === null || b.createdAt < params.windowStart) continue
      const row = byUser.get(b.createdBy) ?? blank(b.createdBy)
      row.broadcastCount += 1
      row.recipientCount += b.recipientCount
      row.sentCount += b.sentCount
      row.failedCount += b.failedCount
      row.suppressedCount += b.suppressedCount
      if (row.lastBroadcastAt === null || b.createdAt > row.lastBroadcastAt) {
        row.lastBroadcastAt = b.createdAt
      }
      byUser.set(b.createdBy, row)
    }
    for (const [userId, state] of this.hosts) {
      if (state.suspended && !byUser.has(userId)) byUser.set(userId, blank(userId))
    }
    const rows = [...byUser.values()]
      .filter((r) => params.suspended === undefined || r.messagingSuspended === params.suspended)
      .map((r) => ({ row: r, createdAt: r.lastBroadcastAt ?? new Date(0), id: r.userId }))
      .filter((keyed) => isBeforeCursor(keyed, params.cursor))
      .sort(newestFirst)
      .slice(0, params.limit)
      .map((keyed) => ({ ...keyed.row, cursorAt: keyed.createdAt.toISOString() }))
    return Promise.resolve(rows)
  }

  updateDraft(
    cleanupId: string,
    broadcastId: string,
    patch: BroadcastDraftPatch,
  ): Promise<BroadcastRecord | null> {
    const found = this.broadcasts.get(broadcastId)
    if (!found || found.cleanupId !== cleanupId || found.status !== "draft") {
      return Promise.resolve(null)
    }
    const next: BroadcastRecord = {
      ...found,
      subject: patch.subject ?? found.subject,
      bodyMd: patch.bodyMd ?? found.bodyMd,
      ctaLabel: "ctaLabel" in patch ? (patch.ctaLabel ?? null) : found.ctaLabel,
      ctaUrl: "ctaUrl" in patch ? (patch.ctaUrl ?? null) : found.ctaUrl,
      segment: patch.segment ?? found.segment,
      channels: patch.channels ? [...patch.channels] : found.channels,
      updatedAt: new Date(),
    }
    this.broadcasts.set(broadcastId, next)
    return Promise.resolve(next)
  }

  deleteDraft(cleanupId: string, broadcastId: string): Promise<boolean> {
    const found = this.broadcasts.get(broadcastId)
    if (!found || found.cleanupId !== cleanupId) return Promise.resolve(false)
    if (!["draft", "scheduled"].includes(found.status)) return Promise.resolve(false)
    if (found.plannedAt !== null) return Promise.resolve(false)
    this.broadcasts.delete(broadcastId)
    return Promise.resolve(true)
  }

  transition(
    broadcastId: string,
    from: readonly BroadcastStatus[],
    to: BroadcastStatus,
    fields: {
      scheduledAt?: Date | null
      startedAt?: Date | null
      finishedAt?: Date | null
      replyTo?: string | null
    } = {},
  ): Promise<BroadcastRecord | null> {
    const found = this.broadcasts.get(broadcastId)
    if (!found || !from.includes(found.status)) return Promise.resolve(null)
    const next: BroadcastRecord = {
      ...found,
      status: to,
      scheduledAt: "scheduledAt" in fields ? (fields.scheduledAt ?? null) : found.scheduledAt,
      startedAt: "startedAt" in fields ? (fields.startedAt ?? null) : found.startedAt,
      finishedAt: "finishedAt" in fields ? (fields.finishedAt ?? null) : found.finishedAt,
      replyTo: "replyTo" in fields ? (fields.replyTo ?? null) : found.replyTo,
      updatedAt: new Date(),
    }
    this.broadcasts.set(broadcastId, next)
    return Promise.resolve(next)
  }

  markPlanned(
    broadcastId: string,
    args: { recipientCount: number; plannedAt: Date },
  ): Promise<boolean> {
    const found = this.broadcasts.get(broadcastId)
    if (!found || found.plannedAt !== null) return Promise.resolve(false)
    let highestChunk = -1
    for (const row of this.deliveries.values()) {
      if (row.broadcastId !== broadcastId) continue
      if (row.chunkNo > highestChunk) highestChunk = row.chunkNo
    }
    this.broadcasts.set(broadcastId, {
      ...found,
      plannedAt: args.plannedAt,
      recipientCount: args.recipientCount,
      chunkCount: highestChunk + 1,
      updatedAt: new Date(),
    })
    return Promise.resolve(true)
  }

  releaseClaims(deliveryIds: readonly string[]): Promise<void> {
    for (const id of deliveryIds) {
      const row = this.deliveries.get(id)
      if (row === undefined) continue
      if (!isOpenDelivery(row)) continue
      row.status = "pending"
      row.attempts = Math.max(row.attempts - 1, 0)
      row.updatedAt = new Date()
    }
    return Promise.resolve()
  }

  listPendingChunks(broadcastId: string): Promise<number[]> {
    const chunks = new Set<number>()
    for (const row of this.deliveries.values()) {
      if (row.broadcastId !== broadcastId) continue
      if (!isOpenDelivery(row)) continue
      chunks.add(row.chunkNo)
    }
    return Promise.resolve([...chunks].sort((a, b) => a - b))
  }

  listStaleSending(staleBefore: Date, limit: number): Promise<string[]> {
    return Promise.resolve(
      [...this.broadcasts.values()]
        .filter(
          (b) => b.status === "sending" && (b.updatedAt?.getTime() ?? 0) < staleBefore.getTime(),
        )
        .slice(0, limit)
        .map((b) => b.id),
    )
  }

  listDueScheduled(now: Date, limit: number): Promise<string[]> {
    return Promise.resolve(
      [...this.broadcasts.values()]
        .filter(
          (b) =>
            b.status === "scheduled" &&
            b.scheduledAt !== null &&
            b.scheduledAt.getTime() <= now.getTime(),
        )
        .slice(0, limit)
        .map((b) => b.id),
    )
  }

  insertDeliveries(rows: readonly DeliveryRowInput[]): Promise<number> {
    let inserted = 0
    for (const row of rows) {
      const key = deliveryKey(row)
      const clash = [...this.deliveries.values()].some((d) => deliveryKey(d) === key)
      if (clash) continue
      const now = new Date()
      const id = randomUUID()
      this.deliveries.set(id, {
        ...row,
        id,
        status: "pending",
        suppressionReason: null,
        failureKind: null,
        providerMessageId: null,
        attempts: 0,
        sentAt: null,
        createdAt: now,
        updatedAt: now,
      })
      inserted += 1
    }
    return Promise.resolve(inserted)
  }

  claimChunk(args: {
    broadcastId: string
    chunkNo: number
    staleBefore: Date
    maxAttempts: number
    limit: number
  }): Promise<DeliveryClaim[]> {
    const claimed: DeliveryClaim[] = []
    for (const row of this.deliveries.values()) {
      if (claimed.length >= args.limit) break
      if (row.broadcastId !== args.broadcastId || row.chunkNo !== args.chunkNo) continue
      if (row.attempts >= args.maxAttempts) continue
      const stale =
        row.status === "in_flight" && row.updatedAt.getTime() < args.staleBefore.getTime()
      if (row.status !== "pending" && !stale) continue
      row.status = "in_flight"
      row.attempts += 1
      row.updatedAt = new Date()
      claimed.push({
        id: row.id,
        chunkNo: row.chunkNo,
        recipientKind: row.recipientKind,
        userId: row.userId,
        guestId: row.guestId,
        channel: row.channel,
        attempts: row.attempts,
      })
    }
    return Promise.resolve(claimed)
  }

  applyDeliveryOutcomes(outcomes: readonly DeliveryOutcome[]): Promise<void> {
    for (const outcome of outcomes) {
      const row = this.deliveries.get(outcome.id)
      if (!row) continue
      row.status = outcome.status
      row.suppressionReason = outcome.suppressionReason ?? null
      row.failureKind = outcome.failureKind ?? null
      row.providerMessageId = outcome.providerMessageId ?? null
      row.sentAt = outcome.sentAt ?? null
      row.updatedAt = new Date()
    }
    return Promise.resolve()
  }

  failExhausted(broadcastId: string, maxAttempts: number): Promise<number> {
    let n = 0
    for (const row of this.deliveries.values()) {
      if (row.broadcastId !== broadcastId) continue
      if (!isOpenDelivery(row)) continue
      if (row.attempts < maxAttempts) continue
      row.status = "failed"
      row.failureKind = "unknown"
      row.updatedAt = new Date()
      n += 1
    }
    return Promise.resolve(n)
  }

  suppressRemaining(broadcastId: string, reason: string): Promise<number> {
    let n = 0
    for (const row of this.deliveries.values()) {
      if (row.broadcastId !== broadcastId) continue
      if (!isOpenDelivery(row)) continue
      row.status = "suppressed"
      row.suppressionReason = reason
      row.updatedAt = new Date()
      n += 1
    }
    return Promise.resolve(n)
  }

  deliveryCounts(broadcastId: string): Promise<DeliveryCounts> {
    const counts: DeliveryCounts = { pending: 0, sent: 0, failed: 0, suppressed: 0, skipped: 0 }
    for (const row of this.deliveries.values()) {
      if (row.broadcastId !== broadcastId) continue
      if (isOpenDelivery(row)) counts.pending += 1
      else if (row.status === "sent") counts.sent += 1
      else if (row.status === "failed") counts.failed += 1
      else if (row.status === "suppressed") counts.suppressed += 1
      else counts.skipped += 1
    }
    return Promise.resolve(counts)
  }

  async refreshCounts(broadcastId: string): Promise<BroadcastRecord | null> {
    const found = this.broadcasts.get(broadcastId)
    if (!found) return null
    const counts = await this.deliveryCounts(broadcastId)
    const next: BroadcastRecord = {
      ...found,
      sentCount: counts.sent,
      failedCount: counts.failed,
      suppressedCount: counts.suppressed + counts.skipped,
      updatedAt: new Date(),
    }
    this.broadcasts.set(broadcastId, next)
    return next
  }

  listDeliveries(query: DeliveryListQuery): Promise<KeysetRow<DeliveryListRow>[]> {
    const rows = [...this.deliveries.values()]
      .filter((d) => d.broadcastId === query.broadcastId)
      .filter((d) => query.status === undefined || d.status === query.status)
      .filter((d) => query.channel === undefined || d.channel === query.channel)
      .filter((d) => isBeforeCursor(d, query.cursor))
      .sort(newestFirst)
      .slice(0, query.limit)
      .map((d) => ({
        id: d.id,
        channel: d.channel,
        recipientKind: d.recipientKind,
        status: d.status as DeliveryListRow["status"],
        suppressionReason: d.suppressionReason,
        failureKind: d.failureKind,
        attempts: d.attempts,
        sentAt: d.sentAt,
        createdAt: d.createdAt,
        cursorAt: d.createdAt.toISOString(),
      }))
    return Promise.resolve(rows)
  }

  memberContacts(userIds: readonly string[]): Promise<Map<string, MemberContact>> {
    const out = new Map<string, MemberContact>()
    for (const rows of this.members.values()) {
      for (const row of rows) {
        if (!userIds.includes(row.userId) || row.deleted === true) continue
        out.set(row.userId, {
          userId: row.userId,
          email: row.contact?.email ?? `${row.userId}@example.test`,
          emailVerified: row.contact?.emailVerified ?? true,
          displayName: row.contact?.displayName ?? "Member",
          firstName: row.contact?.firstName ?? "Member",
          locale: row.contact?.locale ?? null,
        })
      }
    }
    return Promise.resolve(out)
  }

  pushPrefs(userIds: readonly string[]): Promise<Map<string, NotificationPrefsRecord>> {
    const out = new Map<string, NotificationPrefsRecord>()
    for (const rows of this.members.values()) {
      for (const row of rows) {
        if (!userIds.includes(row.userId)) continue
        out.set(row.userId, {
          ...DEFAULT_PREFS,
          push: row.pushPref ?? true,
          hostBroadcasts: row.hostBroadcastsPref ?? true,
          quietStart: row.quietHours?.start ?? null,
          quietEnd: row.quietHours?.end ?? null,
          tz: row.quietHours?.tz ?? null,
        })
      }
    }
    return Promise.resolve(out)
  }

  guestContacts(guestIds: readonly string[]): Promise<Map<string, GuestContact>> {
    const out = new Map<string, GuestContact>()
    for (const rows of this.guests.values()) {
      for (const row of rows) {
        if (!guestIds.includes(row.guestId)) continue
        if (row.cancelled === true || row.scrubbed === true) continue
        out.set(row.guestId, {
          guestId: row.guestId,
          email: row.email ?? `${row.guestId}@example.test`,
          name: row.name ?? "Guest",
        })
      }
    }
    return Promise.resolve(out)
  }

  ticketTypeNames(args: {
    cleanupId: string
    userIds: readonly string[]
    guestIds: readonly string[]
  }): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    for (const row of this.members.get(args.cleanupId) ?? []) {
      if (!args.userIds.includes(row.userId)) continue
      const name = row.ticketTypeName
      if (name != null) out.set(row.userId, name)
    }
    for (const row of this.guests.get(args.cleanupId) ?? []) {
      if (!args.guestIds.includes(row.guestId)) continue
      const name = row.ticketTypeName
      if (name != null) out.set(row.guestId, name)
    }
    return Promise.resolve(out)
  }

  eventContext(cleanupId: string): Promise<EventBroadcastContext | null> {
    return Promise.resolve(this.events.get(cleanupId) ?? null)
  }

  eventContexts(cleanupIds: readonly string[]): Promise<Map<string, EventBroadcastContext>> {
    const out = new Map<string, EventBroadcastContext>()
    for (const id of cleanupIds) {
      const event = this.events.get(id)
      if (event !== undefined) out.set(id, event)
    }
    return Promise.resolve(out)
  }

  hostMessagingState(userId: string): Promise<HostMessagingState | null> {
    if (this.deletedHosts.has(userId)) return Promise.resolve(null)
    return Promise.resolve(this.hosts.get(userId) ?? null)
  }

  setHostMessagingSuspended(
    userId: string,
    suspended: boolean,
    audit: WriteAuditInput,
  ): Promise<boolean> {
    // A seeded host stands in for a users row: the Postgres upsert selects from live users, so an
    // unknown or soft-deleted id changes nothing and writes no audit row.
    const existing = this.hosts.get(userId)
    if (existing === undefined || this.deletedHosts.has(userId)) return Promise.resolve(false)
    this.hosts.set(userId, { ...existing, suspended })
    this.audits.push(audit)
    return Promise.resolve(true)
  }

  isEmailSuppressed(emailHash: string): Promise<boolean> {
    return Promise.resolve(this.suppressedEmails.has(emailHash))
  }

  suppressedEmailHashes(emailHashes: readonly string[]): Promise<Set<string>> {
    return Promise.resolve(new Set(emailHashes.filter((hash) => this.suppressedEmails.has(hash))))
  }

  suppressEmail(emailHash: string, reason: string): Promise<void> {
    this.suppressedEmails.set(emailHash, reason)
    return Promise.resolve()
  }

  recordUnsubscribe(args: {
    scope: "event" | "global"
    cleanupId: string | null
    subjectKind: "user" | "guest"
    subjectId: string
  }): Promise<void> {
    this.unsubscribes.add(
      unsubscribeKey(args.scope, args.cleanupId, args.subjectKind, args.subjectId),
    )
    return Promise.resolve()
  }

  setEventMute(cleanupId: string, userId: string, muted: boolean): Promise<void> {
    const key = muteKey(cleanupId, userId)
    if (muted) this.mutes.add(key)
    else this.mutes.delete(key)
    return Promise.resolve()
  }

  isEventMuted(cleanupId: string, userId: string): Promise<boolean> {
    return Promise.resolve(this.mutes.has(muteKey(cleanupId, userId)))
  }

  listDueReminders(args: { limit: number }): Promise<DueReminder[]> {
    const due = this.dueReminders.filter(
      (r) =>
        ![...this.broadcasts.values()].some(
          (b) =>
            b.cleanupId === r.cleanupId &&
            b.kind === "reminder" &&
            b.reminderOffsetMin === r.offsetMin,
        ),
    )
    return Promise.resolve(due.slice(0, args.limit))
  }

  audiencePage(query: AudiencePageQuery): Promise<{ members: string[]; guests: string[] }> {
    const members = this.memberAudience(query).filter(
      (id) => query.afterMember === null || id > query.afterMember,
    )
    const guests = this.guestAudience(query).filter(
      (id) => query.afterGuest === null || id > query.afterGuest,
    )
    return Promise.resolve({
      members: members.slice(0, query.limit),
      guests: guests.slice(0, query.limit),
    })
  }

  audienceCount(query: AudienceCountQuery): Promise<number> {
    const members = Math.min(this.memberAudience(query).length, query.cap)
    const guests = Math.min(this.guestAudience(query).length, query.cap)
    return Promise.resolve(members + guests)
  }

  scrubBroadcastContent(cutoff: Date, batchSize: number): Promise<number> {
    let n = 0
    for (const [id, row] of this.broadcasts) {
      if (n >= batchSize) break
      if (row.contentScrubbedAt !== null || row.bodyMd === null) continue
      if (row.kind === ANNOUNCEMENT_BROADCAST_KIND) continue
      if (row.finishedAt === null || row.finishedAt.getTime() >= cutoff.getTime()) continue
      this.broadcasts.set(id, {
        ...row,
        subject: null,
        bodyMd: null,
        ctaLabel: null,
        ctaUrl: null,
        contentScrubbedAt: new Date(),
      })
      n += 1
    }
    return Promise.resolve(n)
  }

  deleteOldDeliveries(cutoff: Date, batchSize: number): Promise<number> {
    let n = 0
    for (const [id, row] of this.deliveries) {
      if (n >= batchSize) break
      if (row.createdAt.getTime() >= cutoff.getTime()) continue
      this.deliveries.delete(id)
      n += 1
    }
    return Promise.resolve(n)
  }

  private memberAudience(query: AudienceScopeQuery): string[] {
    return (this.members.get(query.cleanupId) ?? [])
      .filter((m) => this.memberMatchesSegment(m, query))
      .filter((m) => m.deleted !== true && m.suspended !== true && m.banned !== true)
      .filter((m) => this.memberAudible(query.cleanupId, m, query.kind))
      .map((m) => m.userId)
      .sort()
  }

  private guestAudience(query: AudienceScopeQuery): string[] {
    return (this.guests.get(query.cleanupId) ?? [])
      .filter((g) => this.guestMatchesSegment(g, query))
      .filter((g) => g.cancelled !== true && g.scrubbed !== true && g.email !== null)
      .filter(
        (g) => CRITICAL_BROADCAST_KINDS.has(query.kind) || !this.guestOptedOut(query.cleanupId, g),
      )
      .map((g) => g.guestId)
      .sort()
  }

  private memberAudible(cleanupId: string, member: MemoryMember, kind: BroadcastKind): boolean {
    if (CRITICAL_BROADCAST_KINDS.has(kind)) return true
    if (HOST_COMPOSED_BROADCAST_KINDS.has(kind) && member.hostBroadcastsPref === false) return false
    if (this.mutes.has(muteKey(cleanupId, member.userId))) return false
    if (this.unsubscribes.has(unsubscribeKey("event", cleanupId, "user", member.userId))) {
      return false
    }
    return !this.unsubscribes.has(unsubscribeKey("global", null, "user", member.userId))
  }

  private guestOptedOut(cleanupId: string, guest: MemoryGuest): boolean {
    if (this.unsubscribes.has(unsubscribeKey("event", cleanupId, "guest", guest.guestId))) {
      return true
    }
    return this.unsubscribes.has(unsubscribeKey("global", null, "guest", guest.guestId))
  }

  private memberMatchesSegment(member: MemoryMember, query: AudienceScopeQuery): boolean {
    const segment = query.segment
    switch (segment.kind) {
      case "all_registered":
        return member.registered === true
      case "ticket_types":
        return (
          member.registered === true &&
          member.ticketTypeId != null &&
          segment.ids.includes(member.ticketTypeId)
        )
      case "slots":
        return member.slotId != null && segment.ids.includes(member.slotId)
      case "waitlist":
        return member.waitlisted === true
      case "checked_in":
        return member.registered === true && member.checkedIn === true
      case "not_checked_in":
        return member.registered === true && member.checkedIn !== true
      case "guests_only":
        return false
    }
  }

  private guestMatchesSegment(guest: MemoryGuest, query: AudienceScopeQuery): boolean {
    const segment = query.segment
    switch (segment.kind) {
      case "all_registered":
      case "guests_only":
        return true
      case "ticket_types":
        return (
          guest.registered === true &&
          guest.ticketTypeId != null &&
          segment.ids.includes(guest.ticketTypeId)
        )
      case "waitlist":
        return guest.waitlisted === true
      case "checked_in":
        return guest.registered === true && guest.checkedIn === true
      case "not_checked_in":
        return guest.registered === true && guest.checkedIn !== true
      case "slots":
        return false
    }
  }
}
