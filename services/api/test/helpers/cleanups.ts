import { randomUUID } from "node:crypto"
import { AppError } from "@civfix/shared"
import type { Sql } from "../../src/db/client.js"
import type {
  AttendeeView,
  CancelCleanupOutcome,
  CleanupOrganizationView,
  CreateCleanupOutcome,
  ClaimSlotOutcome,
  JoinCleanupOutcome,
  CleanupBBox,
  CleanupPersonView,
  CleanupRecord,
  CleanupRepository,
  CreateCleanupTxArgs,
  DesiredSlot,
  DuplicateSource,
  EventSlotView,
  LinkedEventView,
  LinkedReportView,
  LeaveCleanupOutcome,
  ListAttendeesArgs,
  ListCleanupsFilters,
  NearPoint,
  OrganizationEventsFilters,
  OrganizationEventsHost,
  RemoveMemberOutcome,
  SignupSeat,
  SlotReconcileResult,
  UpdateCleanupPatch,
} from "../../src/services/cleanup-service.js"
import {
  LINKED_EVENTS_PER_REPORT_CAP,
  MAX_EVENTS_PER_REPORT,
  slotIdentityKey,
  slotWindowKey,
  stripPageBlockMedia,
} from "../../src/services/cleanup-repository.drizzle.js"
import { MAX_LINKED_REPORTS } from "@civfix/shared"
import type {
  CleanupMemberRole,
  EventKind,
  EventVisibility,
  OrganizationMemberRole,
  OrgVerificationKind,
  OrgVerificationStatus,
  ReportCategory,
  ReportStatus,
} from "@civfix/shared"
import { NO_HOST_STANDING, type HostStanding } from "@civfix/shared/host"
import { eventScopeKey, formatReferenceCode, EVENT_PREFIX } from "../../src/db/reference-code.js"
import {
  encodeNearCursor,
  encodeTimeCursor,
  pageWith,
  parseNearCursor,
  parseTimeCursor,
} from "../../src/db/cursor-helpers.js"
import { isPubliclyVisibleStatus } from "../../src/services/report-visibility.js"
import {
  DEFAULT_EVENT_DURATION_MS,
  DEFAULT_EVENT_SLOT_TITLE,
  deriveCleanupStatus,
  eventWindowOf,
  hasEventEnded,
} from "../../src/services/cleanup-rules.js"

function defaultStartOffsetMs(status: CleanupRecord["status"]): number {
  if (status === "active") return -3_600_000
  if (status === "done") return -DEFAULT_EVENT_DURATION_MS - 3_600_000
  return 86_400_000
}

export interface SeedCleanupArgs {
  organizerUserId: string
  id?: string
  type?: CleanupRecord["type"]
  eventKind?: EventKind
  title?: string
  lng?: number
  lat?: number
  status?: CleanupRecord["status"]
  scheduledAt?: Date
  endsAt?: Date
  completedAt?: Date | null
  createdAt?: Date
  jurisdictionGeoid?: string | null
  referenceCode?: string | null
  organizationId?: string | null
  donationUrl?: string | null
  coverMediaId?: string | null
  capacity?: number | null
  bags?: number
}

export async function seedCleanup(sql: Sql, args: SeedCleanupArgs): Promise<string> {
  const id = args.id ?? randomUUID()
  const status = args.status ?? "upcoming"
  const scheduledAt = args.scheduledAt ?? new Date(Date.now() + defaultStartOffsetMs(status))
  const endsAt = args.endsAt ?? new Date(scheduledAt.getTime() + DEFAULT_EVENT_DURATION_MS)
  await sql`
    INSERT INTO cleanups (
      id, organizer_user_id, type, event_kind, title, geom, scheduled_at, ends_at, status,
      completed_at, created_at, jurisdiction_geoid, reference_code, organization_id,
      donation_url, cover_media_id, capacity, bags
    )
    VALUES (
      ${id},
      ${args.organizerUserId},
      ${args.type ?? "site"},
      ${args.eventKind ?? "cleanup"},
      ${args.title ?? "Test cleanup"},
      ST_SetSRID(ST_MakePoint(${args.lng ?? -118.35}, ${args.lat ?? 34.1}), 4326),
      ${scheduledAt},
      ${endsAt},
      ${status},
      ${args.completedAt ?? null},
      ${args.createdAt ?? sql`now()`},
      ${args.jurisdictionGeoid ?? null},
      ${args.referenceCode ?? null},
      ${args.organizationId ?? null},
      ${args.donationUrl ?? null},
      ${args.coverMediaId ?? null},
      ${args.capacity ?? null},
      ${args.bags ?? 0}
    )
  `
  return id
}

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
  completedAt: Date | null
  status: CleanupRecord["status"]
  bring: string[] | null
  address: string | null
  addressSource: CleanupRecord["addressSource"]
  capacity: number | null
  jurisdictionGeoid: string | null
  referenceCode: string | null
  createdAt: Date
  endsAt: Date
  timezone: string | null
  visibility: EventVisibility
  coverMediaId: string | null
  galleryMediaIds: string[]
  donationUrl: string | null
  pageSlug: string | null
  registrationOpensAt: Date | null
  registrationClosesAt: Date | null
  organizationId: string | null
  reminderOffsetsMin: number[] | null
  hostReplyTo: string | null
  hostReplyToVerifiedAt: Date | null
}

interface StoredOrganization {
  id: string
  slug: string
  name: string
  logoKey: string | null
  donationUrl: string | null
  verifiedStatus: OrgVerificationStatus
  verifiedKind: OrgVerificationKind | null
  suspended: boolean
  deleted: boolean
}

interface StoredTicketType {
  id: string
  cleanupId: string
  name: string
  capacity: number | null
  reservedSeats: number
  salesOpensAt: Date | null
  salesClosesAt: Date | null
  accessCodeHash: string | null
}

interface StoredQuestion {
  id: string
  cleanupId: string
  ticketTypeId: string | null
  prompt: string
  showIfQuestionId: string | null
  archived: boolean
}

interface StoredPage {
  cleanupId: string
  status: string
  themeAccent: string
  blocks: unknown[]
}

interface StoredOrgMember {
  organizationId: string
  userId: string
  role: OrganizationMemberRole
}

interface StoredMember {
  cleanupId: string
  userId: string
  role: CleanupMemberRole
}

interface StoredBan {
  cleanupId: string
  userId: string
  bannedByUserId: string
}

interface StoredUser {
  id: string
  displayName: string
  handle: string | null
  bio: string | null
  avatarUrl: string | null
  donationUrl: string | null
}

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

interface StoredLink {
  cleanupId: string
  reportId: string
  linkedByUserId: string | null
  linkedAt: Date
}

interface StoredSlot {
  id: string
  cleanupId: string
  title: string
  description: string | null
  capacity: number | null
  startsAt: Date | null
  endsAt: Date | null
  sortOrder: number
}

interface StoredSlotClaim {
  cleanupId: string
  userId: string
  slotId: string
}

export function haversineMeters(a: NearPoint, b: NearPoint): number {
  const R = 6371008.8
  const toRad = (d: number): number => (d * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

export interface GuestCountSource {
  activeGuestCount(cleanupId: string): number
}

export interface SignupRegistrationSink {
  ensureSignupRegistration(args: {
    cleanupId: string
    userId: string
    seatId: string
    now: Date
  }): unknown
  cancelSignupRegistration(args: { cleanupId: string; userId: string; now: Date }): unknown
  applyBan(args: { cleanupId: string; userId: string; actorId: string; now: Date }): {
    releasedTicketTypeIds: string[]
  }
}

export function signupSeat(): SignupSeat {
  return { seatId: randomUUID(), tokenHash: randomUUID() }
}

export class InMemoryCleanupRepository implements CleanupRepository {
  guestSource: GuestCountSource | null = null
  registrationSink: SignupRegistrationSink | null = null
  readonly cleanups = new Map<string, StoredCleanup>()
  readonly organizations = new Map<string, StoredOrganization>()
  readonly orgMembers: StoredOrgMember[] = []
  private readonly idempotentCleanups = new Map<string, string>()
  readonly members: StoredMember[] = []
  readonly bans: StoredBan[] = []
  readonly users = new Map<string, StoredUser>()
  readonly follows = new Set<string>()
  readonly reports = new Map<string, StoredReport>()
  readonly links: StoredLink[] = []
  readonly slots: StoredSlot[] = []
  readonly slotClaims: StoredSlotClaim[] = []
  readonly ticketTypes: StoredTicketType[] = []
  readonly questions: StoredQuestion[] = []
  readonly pages: StoredPage[] = []
  readonly timeline: {
    cleanupId: string
    kind: string
    reportId: string
    note: string | null
    actorId: string | null
  }[] = []

  readonly jurisdictionContacts = new Map<string, { contact: string; name: string }>()

  now: () => Date = () => new Date()

  private readonly refCounters = new Map<string, number>()

  private allocateEventReferenceCode(jurCode: number): string {
    const scope = eventScopeKey(jurCode)
    const seq = (this.refCounters.get(scope) ?? 0) + 1
    this.refCounters.set(scope, seq)
    return formatReferenceCode(EVENT_PREFIX, jurCode, seq)
  }

  seedUser(over: Partial<StoredUser> = {}): StoredUser {
    const user: StoredUser = {
      id: over.id ?? randomUUID(),
      displayName: over.displayName ?? "Organizer",
      handle: over.handle ?? null,
      bio: over.bio ?? null,
      avatarUrl: over.avatarUrl ?? null,
      donationUrl: over.donationUrl ?? null,
    }
    this.users.set(user.id, user)
    return user
  }

  seedFollow(followerId: string, followeeId: string): void {
    this.follows.add(`${followerId}:${followeeId}`)
  }

  seedMember(cleanupId: string, userId: string, role: CleanupMemberRole = "member"): void {
    if (!this.users.has(userId)) this.seedUser({ id: userId })
    const existing = this.members.find((m) => m.cleanupId === cleanupId && m.userId === userId)
    if (existing) existing.role = role
    else this.members.push({ cleanupId, userId, role })
  }

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

  seedLink(cleanupId: string, reportId: string, linkedByUserId: string | null = null): void {
    this.links.push({ cleanupId, reportId, linkedByUserId, linkedAt: this.now() })
  }

  private reportVisible(r: StoredReport | undefined): r is StoredReport {
    return (
      r !== undefined &&
      !r.deleted &&
      isPubliclyVisibleStatus(r.status) &&
      r.visibility === "public"
    )
  }

  /** `withDefaultSlot: false` reproduces a LEGACY slot-less event — the shape 0169 backfilled away. */
  seedCleanup(
    over: Partial<StoredCleanup> & { id?: string; withDefaultSlot?: boolean },
  ): StoredCleanup {
    const seededStatus = over.status ?? "upcoming"
    const scheduledAt =
      over.scheduledAt ?? new Date(this.now().getTime() + defaultStartOffsetMs(seededStatus))
    const cleanup: StoredCleanup = {
      id: over.id ?? randomUUID(),
      organizerUserId: over.organizerUserId ?? randomUUID(),
      type: over.type ?? "site",
      eventKind: over.eventKind ?? "cleanup",
      title: over.title ?? "Beach cleanup",
      description: over.description ?? null,
      lat: over.lat ?? 34.0,
      lng: over.lng ?? -118.49,
      scheduledAt,
      completedAt: over.completedAt ?? null,
      status: seededStatus === "cancelled" ? "cancelled" : "upcoming",
      bring: over.bring ?? null,
      address: over.address ?? null,
      addressSource: over.addressSource ?? null,
      capacity: over.capacity ?? null,
      jurisdictionGeoid: over.jurisdictionGeoid ?? null,
      referenceCode: over.referenceCode ?? null,
      createdAt: over.createdAt ?? new Date(),
      endsAt: over.endsAt ?? new Date(scheduledAt.getTime() + DEFAULT_EVENT_DURATION_MS),
      timezone: over.timezone ?? null,
      visibility: over.visibility ?? "public",
      coverMediaId: over.coverMediaId ?? null,
      galleryMediaIds: over.galleryMediaIds ?? [],
      donationUrl: over.donationUrl ?? null,
      pageSlug: over.pageSlug ?? null,
      registrationOpensAt: over.registrationOpensAt ?? null,
      registrationClosesAt: over.registrationClosesAt ?? null,
      organizationId: over.organizationId ?? null,
      reminderOffsetsMin: over.reminderOffsetsMin ?? null,
      hostReplyTo: over.hostReplyTo ?? null,
      hostReplyToVerifiedAt: over.hostReplyToVerifiedAt ?? null,
    }
    this.cleanups.set(cleanup.id, cleanup)
    if (!this.users.has(cleanup.organizerUserId)) {
      this.seedUser({ id: cleanup.organizerUserId })
    }
    if (
      !this.members.some((m) => m.cleanupId === cleanup.id && m.userId === cleanup.organizerUserId)
    ) {
      this.members.push({
        cleanupId: cleanup.id,
        userId: cleanup.organizerUserId,
        role: "organizer",
      })
    }
    if (over.withDefaultSlot !== false) {
      this.seedSlot({
        cleanupId: cleanup.id,
        title: DEFAULT_EVENT_SLOT_TITLE,
        capacity: cleanup.capacity,
      })
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
      avatarUrl: u?.avatarUrl ?? null,
      donationUrl: u?.donationUrl ?? null,
    }
  }

  private memberCountOf(cleanupId: string): number {
    return this.members.filter((m) => m.cleanupId === cleanupId).length
  }

  private guestCountOf(cleanupId: string): number {
    return this.guestSource?.activeGuestCount(cleanupId) ?? 0
  }

  private goingOf(cleanupId: string): number {
    return this.memberCountOf(cleanupId) + this.guestCountOf(cleanupId)
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
      completedAt: c.completedAt,
      status: deriveCleanupStatus(eventWindowOf(c), this.now().getTime()),
      bring: c.bring,
      address: c.address,
      addressSource: c.addressSource,
      capacity: c.capacity,
      jurisdictionGeoid: c.jurisdictionGeoid,
      referenceCode: c.referenceCode,
      createdAt: c.createdAt,
      going: this.goingOf(c.id),
      guestCount: this.guestCountOf(c.id),
      dist: near !== null ? haversineMeters(near, { lat: c.lat, lng: c.lng }) : null,
      organizer: this.personView(c.organizerUserId),
      endsAt: c.endsAt,
      timezone: c.timezone,
      visibility: c.visibility,
      coverMediaId: c.coverMediaId,
      coverKey: c.coverMediaId === null ? null : `media/${c.coverMediaId}`,
      galleryMediaIds: [...c.galleryMediaIds],
      donationUrl: c.donationUrl,
      pageSlug: c.pageSlug,
      registrationOpensAt: c.registrationOpensAt,
      registrationClosesAt: c.registrationClosesAt,
      organizationId: c.organizationId,
      organization: c.organizationId === null ? null : this.orgViewOf(c.organizationId),
      reminderOffsetsMin: c.reminderOffsetsMin,
      hostReplyTo: c.hostReplyTo,
      hostReplyToVerifiedAt: c.hostReplyToVerifiedAt,
    }
  }

  private orgViewOf(organizationId: string): CleanupOrganizationView | null {
    const org = this.organizations.get(organizationId)
    if (org === undefined || org.deleted) return null
    return {
      id: org.id,
      slug: org.slug,
      name: org.name,
      logoKey: org.logoKey,
      donationUrl: org.donationUrl,
      verifiedStatus: org.verifiedStatus,
      verifiedKind: org.verifiedKind,
      suspended: org.suspended,
    }
  }

  createCleanupTx(args: CreateCleanupTxArgs): Promise<CreateCleanupOutcome> {
    const idem = args.idempotency
    if (idem !== undefined) {
      const replayId = this.idempotentCleanups.get(this.idempotencyKeyOf(idem))
      if (replayId !== undefined) {
        const existing = this.cleanups.get(replayId)
        if (existing !== undefined) {
          return Promise.resolve({ record: this.toRecord(existing, null), replayed: true })
        }
      }
    }
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
      completedAt: null,
      status: args.status,
      bring: args.bring,
      address: args.address,
      addressSource: args.addressSource,
      capacity: null,
      jurisdictionGeoid: args.jurisdictionGeoid,
      referenceCode,
      createdAt: this.now(),
      endsAt: args.host.endsAt,
      timezone: args.host.timezone ?? null,
      visibility: args.host.visibility ?? "public",
      coverMediaId: args.host.coverMediaId ?? null,
      galleryMediaIds: [...(args.host.galleryMediaIds ?? [])],
      donationUrl: args.host.donationUrl ?? null,
      pageSlug: args.host.pageSlug ?? null,
      registrationOpensAt: args.host.registrationOpensAt ?? null,
      registrationClosesAt: args.host.registrationClosesAt ?? null,
      organizationId: args.host.organizationId ?? null,
      reminderOffsetsMin: args.host.reminderOffsetsMin ?? null,
      hostReplyTo: args.host.hostReplyTo ?? null,
      hostReplyToVerifiedAt: null,
    }
    this.cleanups.set(cleanup.id, cleanup)
    this.members.push({ cleanupId: cleanup.id, userId: cleanup.organizerUserId, role: "organizer" })
    if (!this.users.has(cleanup.organizerUserId)) {
      this.seedUser({ id: cleanup.organizerUserId })
    }
    this.linkInner(cleanup.id, args.linkedReportIds, args.organizerUserId)
    for (const slot of args.slots) this.insertSlot(cleanup.id, slot)
    if (args.copyFrom !== undefined) this.copyEventExtras(cleanup.id, args.copyFrom)
    if (idem !== undefined) this.idempotentCleanups.set(this.idempotencyKeyOf(idem), cleanup.id)
    return Promise.resolve({ record: this.toRecord(cleanup, null), replayed: false })
  }

  private copyEventExtras(cleanupId: string, source: DuplicateSource): void {
    const typeIds = new Map<string, string>()
    if (source.ticketTypes) {
      for (const type of this.ticketTypes.filter((t) => t.cleanupId === source.cleanupId)) {
        const id = randomUUID()
        typeIds.set(type.id, id)
        const now = this.now().getTime()
        this.ticketTypes.push({
          ...type,
          id,
          cleanupId,
          reservedSeats: 0,
          salesOpensAt:
            type.salesOpensAt !== null && type.salesOpensAt.getTime() > now
              ? type.salesOpensAt
              : null,
          salesClosesAt:
            type.salesClosesAt !== null && type.salesClosesAt.getTime() > now
              ? type.salesClosesAt
              : null,
        })
      }
    }
    if (source.questions) {
      const live = this.questions.filter((q) => q.cleanupId === source.cleanupId && !q.archived)
      const questionIds = new Map(live.map((q) => [q.id, randomUUID()]))
      for (const question of live) {
        this.questions.push({
          ...question,
          id: questionIds.get(question.id) as string,
          cleanupId,
          ticketTypeId:
            question.ticketTypeId === null ? null : (typeIds.get(question.ticketTypeId) ?? null),
          showIfQuestionId:
            question.showIfQuestionId === null
              ? null
              : (questionIds.get(question.showIfQuestionId) ?? null),
        })
      }
    }
    if (source.page) {
      const page = this.pages.find((p) => p.cleanupId === source.cleanupId)
      if (page !== undefined) {
        this.pages.push({
          cleanupId,
          status: "draft",
          themeAccent: page.themeAccent,
          blocks: page.blocks.map((block) => stripPageBlockMedia(block)),
        })
      }
    }
  }

  private idempotencyKeyOf(idem: { key: string; scope: string; userOrAnon: string }): string {
    return `${idem.scope}|${idem.userOrAnon}|${idem.key}`
  }

  private insertSlot(cleanupId: string, slot: DesiredSlot): string {
    const id = randomUUID()
    this.slots.push({
      id,
      cleanupId,
      title: slot.title,
      description: slot.description,
      capacity: slot.capacity,
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
      sortOrder: slot.sortOrder,
    })
    return id
  }

  seedSlot(over: Partial<StoredSlot> & { cleanupId: string }): StoredSlot {
    const slot: StoredSlot = {
      id: over.id ?? randomUUID(),
      cleanupId: over.cleanupId,
      title: over.title ?? "Registration table",
      description: over.description ?? null,
      capacity: over.capacity ?? null,
      startsAt: over.startsAt ?? null,
      endsAt: over.endsAt ?? null,
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
    const c = [...this.cleanups.values()].find((x) => x.referenceCode === code)
    return Promise.resolve(c ? this.toRecord(c, null) : null)
  }

  findCleanupByPageSlug(slug: string): Promise<CleanupRecord | null> {
    const c = [...this.cleanups.values()].find((x) => x.pageSlug === slug)
    return Promise.resolve(c ? this.toRecord(c, null) : null)
  }

  galleryKeysFor(cleanupId: string): Promise<string[]> {
    const c = this.cleanups.get(cleanupId)
    return Promise.resolve((c?.galleryMediaIds ?? []).map((id) => `media/${id}`))
  }

  loadOrganizationRef(organizationId: string): Promise<CleanupOrganizationView | null> {
    return Promise.resolve(this.orgViewOf(organizationId))
  }

  findOrganizationEventsHost(
    slug: string,
    viewerId: string | null,
  ): Promise<OrganizationEventsHost | null> {
    const org = [...this.organizations.values()].find(
      (o) => !o.deleted && o.slug.toLowerCase() === slug.toLowerCase(),
    )
    if (org === undefined) return Promise.resolve(null)
    const organization = this.orgViewOf(org.id)
    if (organization === null) return Promise.resolve(null)
    return Promise.resolve({
      organization,
      viewerIsMember:
        viewerId !== null &&
        this.orgMembers.some((m) => m.organizationId === org.id && m.userId === viewerId),
    })
  }

  orgRoleOf(organizationId: string, userId: string): Promise<OrganizationMemberRole | null> {
    const member = this.orgMembers.find(
      (m) => m.organizationId === organizationId && m.userId === userId,
    )
    return Promise.resolve(member?.role ?? null)
  }

  async standingOf(cleanupId: string, userId: string): Promise<HostStanding> {
    const cleanup = this.cleanups.get(cleanupId)
    if (cleanup === undefined) return NO_HOST_STANDING
    const eventRole = await this.roleOf(cleanupId, userId)
    const orgRole =
      cleanup.organizationId === null ? null : await this.orgRoleOf(cleanup.organizationId, userId)
    if (eventRole === null && orgRole === null) return NO_HOST_STANDING
    return { eventRole, orgRole }
  }

  async standingsOf(cleanupIds: string[], userId: string): Promise<Map<string, HostStanding>> {
    const out = new Map<string, HostStanding>()
    for (const cleanupId of cleanupIds) {
      out.set(cleanupId, await this.standingOf(cleanupId, userId))
    }
    return out
  }

  seedOrganization(over: Partial<StoredOrganization> & { id?: string } = {}): StoredOrganization {
    const org: StoredOrganization = {
      id: over.id ?? randomUUID(),
      slug: over.slug ?? `org-${this.organizations.size + 1}`,
      name: over.name ?? "Ballona Creek Trust",
      logoKey: over.logoKey ?? null,
      donationUrl: over.donationUrl ?? null,
      verifiedStatus: over.verifiedStatus ?? "unverified",
      verifiedKind: over.verifiedKind ?? null,
      suspended: over.suspended ?? false,
      deleted: over.deleted ?? false,
    }
    this.organizations.set(org.id, org)
    return org
  }

  seedTicketType(over: Partial<StoredTicketType> & { cleanupId: string }): StoredTicketType {
    const type: StoredTicketType = {
      id: over.id ?? randomUUID(),
      cleanupId: over.cleanupId,
      name: over.name ?? "General admission",
      capacity: over.capacity ?? null,
      reservedSeats: over.reservedSeats ?? 0,
      salesOpensAt: over.salesOpensAt ?? null,
      salesClosesAt: over.salesClosesAt ?? null,
      accessCodeHash: over.accessCodeHash ?? null,
    }
    this.ticketTypes.push(type)
    return type
  }

  seedQuestion(over: Partial<StoredQuestion> & { cleanupId: string }): StoredQuestion {
    const question: StoredQuestion = {
      id: over.id ?? randomUUID(),
      cleanupId: over.cleanupId,
      ticketTypeId: over.ticketTypeId ?? null,
      prompt: over.prompt ?? "Any accessibility needs?",
      showIfQuestionId: over.showIfQuestionId ?? null,
      archived: over.archived ?? false,
    }
    this.questions.push(question)
    return question
  }

  seedPage(over: Partial<StoredPage> & { cleanupId: string }): StoredPage {
    const page: StoredPage = {
      cleanupId: over.cleanupId,
      status: over.status ?? "published",
      themeAccent: over.themeAccent ?? "bloom",
      blocks: over.blocks ?? [],
    }
    this.pages.push(page)
    return page
  }

  seedOrgMember(organizationId: string, userId: string, role: OrganizationMemberRole): void {
    const existing = this.orgMembers.find(
      (m) => m.organizationId === organizationId && m.userId === userId,
    )
    if (existing) existing.role = role
    else this.orgMembers.push({ organizationId, userId, role })
  }

  private linkInner(cleanupId: string, reportIds: string[], actorId: string | null): string[] {
    const overCap = reportIds.filter(
      (reportId) =>
        this.links.filter((l) => l.reportId === reportId && l.cleanupId !== cleanupId).length >=
        MAX_EVENTS_PER_REPORT,
    )
    if (overCap.length > 0) {
      throw AppError.validation({
        linkedReportIds: `already linked to the maximum number of events: ${overCap.join(", ")}`,
      })
    }
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
    if (patch.addressSource !== undefined) c.addressSource = patch.addressSource
    if (patch.bring !== undefined) c.bring = patch.bring
    if (patch.jurisdictionGeoid !== undefined) c.jurisdictionGeoid = patch.jurisdictionGeoid
    if (patch.endsAt !== undefined) c.endsAt = patch.endsAt
    if (patch.timezone !== undefined) c.timezone = patch.timezone
    if (patch.visibility !== undefined) c.visibility = patch.visibility
    if (patch.coverMediaId !== undefined) c.coverMediaId = patch.coverMediaId
    if (patch.galleryMediaIds !== undefined) c.galleryMediaIds = [...patch.galleryMediaIds]
    if (patch.donationUrl !== undefined) c.donationUrl = patch.donationUrl
    if (patch.pageSlug !== undefined) c.pageSlug = patch.pageSlug
    if (patch.registrationOpensAt !== undefined) {
      c.registrationOpensAt = patch.registrationOpensAt
    }
    if (patch.registrationClosesAt !== undefined) {
      c.registrationClosesAt = patch.registrationClosesAt
    }
    if (patch.organizationId !== undefined) c.organizationId = patch.organizationId
    if (patch.reminderOffsetsMin !== undefined) c.reminderOffsetsMin = patch.reminderOffsetsMin
    if (patch.hostReplyTo !== undefined) {
      c.hostReplyTo = patch.hostReplyTo
      c.hostReplyToVerifiedAt = null
    }
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
    const toRemove = have.filter((id) => !want.has(id) && this.reportVisible(this.reports.get(id)))
    const added = this.linkInner(cleanupId, toAdd, actorId)
    for (const reportId of toRemove) {
      const idx = this.links.findIndex((l) => l.cleanupId === cleanupId && l.reportId === reportId)
      if (idx >= 0) this.links.splice(idx, 1)
      this.timeline.push({ cleanupId, kind: "report_unlinked", reportId, note: null, actorId })
    }
    return Promise.resolve({ added, removed: toRemove })
  }

  loadLinkedReportsForCleanups(
    cleanupIds: string[],
    perCleanupCap: number = MAX_LINKED_REPORTS,
  ): Promise<Map<string, LinkedReportView[]>> {
    const ids = new Set(cleanupIds)
    const grouped = new Map<string, LinkedReportView[]>()
    const ordered = [...this.links]
      .filter((l) => ids.has(l.cleanupId))
      .sort((a, b) => b.linkedAt.getTime() - a.linkedAt.getTime())
    for (const link of ordered) {
      const r = this.reports.get(link.reportId)
      if (!this.reportVisible(r)) continue
      if ((grouped.get(link.cleanupId)?.length ?? 0) >= perCleanupCap) continue
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
      if (!c || c.visibility !== "public") continue
      if ((grouped.get(link.reportId)?.length ?? 0) >= LINKED_EVENTS_PER_REPORT_CAP) continue
      const view: LinkedEventView = {
        reportId: link.reportId,
        id: c.id,
        title: c.title,
        eventKind: c.eventKind,
        status: deriveCleanupStatus(eventWindowOf(c), this.now().getTime()),
        scheduledAt: c.scheduledAt,
        endsAt: c.endsAt,
        timezone: c.timezone,
        lat: c.lat,
        lng: c.lng,
        going: this.goingOf(c.id),
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
    const visible = new Set(reportIds.filter((id) => this.reportVisible(this.reports.get(id))))
    return Promise.resolve(visible)
  }

  private privateBlocksJoin(c: StoredCleanup, userId: string): boolean {
    if (c.visibility !== "private") return false
    return !this.visibleInFeed(c, userId)
  }

  private visibleInFeed(c: StoredCleanup, viewerId: string | null): boolean {
    if (c.visibility === "public") return true
    if (viewerId === null) return false
    if (this.members.some((m) => m.cleanupId === c.id && m.userId === viewerId)) return true
    return (
      c.organizationId !== null &&
      this.orgMembers.some((m) => m.organizationId === c.organizationId && m.userId === viewerId)
    )
  }

  listCleanups(
    filters: ListCleanupsFilters,
  ): Promise<{ records: CleanupRecord[]; nextCursor: string | null }> {
    const nowMs = this.now().getTime()
    const near = filters.near ?? null

    const inBox = (c: StoredCleanup, bbox: CleanupBBox): boolean =>
      c.lng >= bbox.west && c.lng <= bbox.east && c.lat >= bbox.south && c.lat <= bbox.north

    let all = [...this.cleanups.values()].filter((c) => {
      if (filters.when === "upcoming" || filters.when === "attending") {
        if (c.status === "cancelled" || c.endsAt.getTime() <= nowMs) return false
      } else if (filters.when === "past") {
        if (c.status === "cancelled" || c.endsAt.getTime() > nowMs) return false
      } else if (c.status === "cancelled") {
        return false
      }
      if (filters.when === "attending") {
        const viewerId = filters.viewerId ?? null
        if (
          viewerId === null ||
          !this.members.some((m) => m.cleanupId === c.id && m.userId === viewerId)
        )
          return false
      }
      if (filters.bbox !== undefined && !inBox(c, filters.bbox)) return false
      if (!this.visibleInFeed(c, filters.viewerId ?? null)) return false
      return true
    })

    if (near !== null) {
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
      const { items, nextCursor } = pageWith(after, filters.limit, (last) =>
        encodeNearCursor({ dist: last.dist, id: last.c.id }),
      )
      const records = items.map((x) => this.toRecord(x.c, near))
      return Promise.resolve({ records, nextCursor })
    }

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
    const { items, nextCursor } = pageWith(after, filters.limit, (last) =>
      encodeTimeCursor({ at: last.scheduledAt, id: last.id }),
    )
    const records = items.map((c) => this.toRecord(c, null))
    return Promise.resolve({ records, nextCursor })
  }

  listOrganizationEvents(
    filters: OrganizationEventsFilters,
  ): Promise<{ records: CleanupRecord[]; nextCursor: string | null }> {
    const nowMs = this.now().getTime()
    const past = filters.when === "past"
    const matching = [...this.cleanups.values()].filter((c) => {
      if (c.organizationId !== filters.organizationId) return false
      if (c.visibility !== "public") return false
      if (past) return c.status !== "cancelled" && c.endsAt.getTime() <= nowMs
      return c.status !== "cancelled" && c.endsAt.getTime() > nowMs
    })
    matching.sort((a, b) => {
      const cmp = a.scheduledAt.getTime() - b.scheduledAt.getTime()
      if (cmp !== 0) return past ? -cmp : cmp
      const idCmp = a.id < b.id ? -1 : a.id > b.id ? 1 : 0
      return past ? -idCmp : idCmp
    })
    const cursor = parseTimeCursor(filters.cursor)
    const after =
      cursor !== null
        ? matching.filter((c) => {
            const t = c.scheduledAt.getTime()
            const ct = cursor.at.getTime()
            if (past) return t < ct || (t === ct && c.id < cursor.id)
            return t > ct || (t === ct && c.id > cursor.id)
          })
        : matching
    const { items, nextCursor } = pageWith(after, filters.limit, (last) =>
      encodeTimeCursor({ at: last.scheduledAt, id: last.id }),
    )
    return Promise.resolve({ records: items.map((c) => this.toRecord(c, null)), nextCursor })
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

  setMemberRole(
    cleanupId: string,
    userId: string,
    role: "cohost" | "staff" | "member",
  ): Promise<boolean> {
    const m = this.members.find((x) => x.cleanupId === cleanupId && x.userId === userId)
    if (!m || m.role === "organizer") return Promise.resolve(false)
    m.role = role
    return Promise.resolve(true)
  }

  removeMember(cleanupId: string, userId: string, actorId: string): Promise<RemoveMemberOutcome> {
    const cleanup = this.cleanups.get(cleanupId)
    if (cleanup === undefined) return Promise.resolve({ kind: "not_found" })
    if (cleanup.status === "cancelled") return Promise.resolve({ kind: "closed" })
    const idx = this.members.findIndex(
      (m) => m.cleanupId === cleanupId && m.userId === userId && m.role !== "organizer",
    )
    let releasedWaitlistTicketTypeIds: string[] = []
    if (idx >= 0) {
      this.members.splice(idx, 1)
      const ban = this.registrationSink?.applyBan({ cleanupId, userId, actorId, now: this.now() })
      releasedWaitlistTicketTypeIds = ban?.releasedTicketTypeIds ?? []
      if (!this.bans.some((b) => b.cleanupId === cleanupId && b.userId === userId)) {
        this.bans.push({ cleanupId, userId, bannedByUserId: actorId })
      }
      this.deleteClaim(cleanupId, userId)
    }
    const going = this.goingOf(cleanupId)
    return Promise.resolve(
      idx >= 0
        ? { kind: "removed", going, releasedWaitlistTicketTypeIds }
        : { kind: "not_member", going },
    )
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
    const ids = this.members
      .filter((m) => m.cleanupId === cleanupId)
      .map((m) => m.userId)
      .slice(0, limit)
    return Promise.resolve(ids)
  }

  goingCount(cleanupId: string): Promise<number> {
    return Promise.resolve(this.goingOf(cleanupId))
  }

  organizerOf(cleanupId: string): Promise<string | null> {
    const c = this.cleanups.get(cleanupId)
    return Promise.resolve(c ? c.organizerUserId : null)
  }

  joinCleanupTx(cleanupId: string, userId: string, seat: SignupSeat): Promise<JoinCleanupOutcome> {
    const cleanup = this.cleanups.get(cleanupId)
    if (cleanup === undefined) return Promise.resolve("not_found")
    if (this.privateBlocksJoin(cleanup, userId)) return Promise.resolve("not_found")
    if (cleanup.status === "cancelled") return Promise.resolve("closed")
    if (hasEventEnded(eventWindowOf(cleanup), this.now().getTime())) return Promise.resolve("ended")
    if (this.bans.some((b) => b.cleanupId === cleanupId && b.userId === userId)) {
      return Promise.resolve("banned")
    }
    if (!this.members.some((m) => m.cleanupId === cleanupId && m.userId === userId)) {
      this.members.push({ cleanupId, userId, role: "member" })
    }
    this.ensureSignupRegistration(cleanupId, userId, seat)
    return Promise.resolve("joined")
  }

  leaveCleanup(cleanupId: string, userId: string): Promise<LeaveCleanupOutcome> {
    const cleanup = this.cleanups.get(cleanupId)
    if (cleanup === undefined) return Promise.resolve("not_found")
    if (cleanup.status === "cancelled") return Promise.resolve("closed")
    const idx = this.members.findIndex((m) => m.cleanupId === cleanupId && m.userId === userId)
    if (idx >= 0) this.members.splice(idx, 1)
    this.cancelSignupRegistration(cleanupId, userId)
    this.deleteClaim(cleanupId, userId)
    return Promise.resolve("left")
  }

  private ensureSignupRegistration(cleanupId: string, userId: string, seat: SignupSeat): void {
    if (this.registrationSink === null) return
    this.registrationSink.ensureSignupRegistration({
      cleanupId,
      userId,
      seatId: seat.seatId,
      now: this.now(),
    })
  }

  private cancelSignupRegistration(cleanupId: string, userId: string): void {
    if (this.registrationSink === null) return
    this.registrationSink.cancelSignupRegistration({ cleanupId, userId, now: this.now() })
  }

  private deleteClaim(cleanupId: string, userId: string): string | null {
    const idx = this.slotClaims.findIndex((c) => c.cleanupId === cleanupId && c.userId === userId)
    if (idx < 0) return null
    const [claim] = this.slotClaims.splice(idx, 1)
    return claim?.slotId ?? null
  }

  cancelCleanupTx(
    id: string,
    input: { note: string; body: string; reason: string | null; actorId: string },
  ): Promise<CancelCleanupOutcome> {
    const c = this.cleanups.get(id)
    if (!c) return Promise.resolve("not_found")
    if (c.status === "cancelled") return Promise.resolve("already_cancelled")
    if (c.endsAt.getTime() <= this.now().getTime()) return Promise.resolve("already_ended")
    c.status = "cancelled"
    this.timeline.push({
      cleanupId: id,
      kind: "cancel",
      reportId: "",
      note: input.note,
      actorId: input.actorId,
    })
    return Promise.resolve("cancelled")
  }

  listAttendees(args: ListAttendeesArgs): Promise<AttendeeView[]> {
    const { cleanupId, viewerId, onlyFollowed, limit } = args
    const follows = (userId: string): boolean =>
      viewerId !== null && this.follows.has(`${viewerId}:${userId}`)

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

  private slotViews(cleanupId: string, viewerId: string | null): EventSlotView[] {
    return this.slots
      .filter((s) => s.cleanupId === cleanupId)
      .sort((a, b) =>
        a.sortOrder !== b.sortOrder ? a.sortOrder - b.sortOrder : a.id < b.id ? -1 : 1,
      )
      .map((s) => ({
        cleanupId: s.cleanupId,
        id: s.id,
        title: s.title,
        description: s.description,
        capacity: s.capacity,
        startsAt: s.startsAt,
        endsAt: s.endsAt,
        sortOrder: s.sortOrder,
        claimed: this.slotClaims.filter((c) => c.slotId === s.id).length,
        mine:
          viewerId !== null &&
          this.slotClaims.some((c) => c.slotId === s.id && c.userId === viewerId),
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

    for (const slot of desired) {
      if (slot.id !== undefined && !haveIds.has(slot.id)) {
        throw AppError.validation({ slots: `unknown slot: ${slot.id}` })
      }
    }

    const seenTitles = new Set<string>()
    for (const slot of desired) {
      const key = slotIdentityKey(slot)
      if (seenTitles.has(key)) throw AppError.validation({ slots: "duplicate slot title" })
      seenTitles.add(key)
    }

    const keep = new Set(desired.map((s) => s.id).filter((id): id is string => id !== undefined))
    const removed: SlotReconcileResult["removed"] = []
    for (const row of have) {
      if (keep.has(row.id)) continue
      const claimantUserIds = this.slotClaims
        .filter((c) => c.slotId === row.id)
        .map((c) => c.userId)
        .filter((u) => u !== actorId)
      for (let i = this.slotClaims.length - 1; i >= 0; i--) {
        if (this.slotClaims[i]!.slotId === row.id) this.slotClaims.splice(i, 1)
      }
      const idx = this.slots.findIndex((s) => s.id === row.id)
      if (idx >= 0) this.slots.splice(idx, 1)
      removed.push({ slotId: row.id, title: row.title, claimantUserIds })
    }

    const added: string[] = []
    const updated: string[] = []
    const rescheduled: SlotReconcileResult["rescheduled"] = []
    for (const slot of desired) {
      if (slot.id !== undefined) {
        const row = this.slots.find((s) => s.id === slot.id && s.cleanupId === cleanupId)
        if (row) {
          const moved = slotWindowKey(row) !== slotWindowKey(slot)
          const claimantUserIds = moved
            ? this.slotClaims
                .filter((c) => c.slotId === row.id)
                .map((c) => c.userId)
                .filter((u) => u !== actorId)
            : []
          row.title = slot.title
          row.description = slot.description
          row.capacity = slot.capacity
          row.startsAt = slot.startsAt
          row.endsAt = slot.endsAt
          row.sortOrder = slot.sortOrder
          updated.push(row.id)
          if (claimantUserIds.length > 0) {
            rescheduled.push({ slotId: row.id, title: row.title, claimantUserIds })
          }
        }
      } else {
        added.push(this.insertSlot(cleanupId, slot))
      }
    }
    return Promise.resolve({ added, updated, removed, rescheduled })
  }

  claimSlot(
    cleanupId: string,
    userId: string,
    slotId: string,
    seat: SignupSeat,
  ): Promise<ClaimSlotOutcome> {
    const cleanup = this.cleanups.get(cleanupId)
    if (!cleanup) return Promise.resolve({ kind: "not_found" })
    if (this.privateBlocksJoin(cleanup, userId)) return Promise.resolve({ kind: "not_found" })
    if (cleanup.status === "cancelled") return Promise.resolve({ kind: "closed" })
    if (hasEventEnded(eventWindowOf(cleanup), this.now().getTime())) {
      return Promise.resolve({ kind: "ended" })
    }
    if (this.bans.some((b) => b.cleanupId === cleanupId && b.userId === userId)) {
      return Promise.resolve({ kind: "banned" })
    }

    const current = this.slotClaims.find((c) => c.cleanupId === cleanupId && c.userId === userId)
    const slot = this.slots.find((s) => s.id === slotId && s.cleanupId === cleanupId)
    if (!slot) return Promise.resolve({ kind: "slot_not_found" })

    if (current?.slotId === slotId) return Promise.resolve({ kind: "claimed", slotId })

    if (slot.capacity !== null) {
      const claimed = this.slotClaims.filter((c) => c.slotId === slotId).length
      if (claimed >= slot.capacity) return Promise.resolve({ kind: "full" })
    }
    if (!this.members.some((m) => m.cleanupId === cleanupId && m.userId === userId)) {
      this.members.push({ cleanupId, userId, role: "member" })
      if (!this.users.has(userId)) this.seedUser({ id: userId })
    }
    this.ensureSignupRegistration(cleanupId, userId, seat)
    if (current) current.slotId = slotId
    else this.slotClaims.push({ cleanupId, userId, slotId })
    return Promise.resolve({ kind: "claimed", slotId })
  }

  releaseSlot(cleanupId: string, userId: string): Promise<ClaimSlotOutcome> {
    const cleanup = this.cleanups.get(cleanupId)
    if (!cleanup) return Promise.resolve({ kind: "not_found" })
    if (cleanup.status === "cancelled") return Promise.resolve({ kind: "closed" })
    this.deleteClaim(cleanupId, userId)
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
