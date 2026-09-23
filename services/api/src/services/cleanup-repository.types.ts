import type {
  CleanupMemberRole,
  CleanupStatus,
  CleanupType,
  EventAddressSource,
  EventKind,
  EventVisibility,
  OrganizationMemberRole,
  OrgVerificationKind,
  OrgVerificationStatus,
  ReportCategory,
  ReportStatus,
  ReportType,
} from "@civfix/shared"
import type { HostStanding } from "@civfix/shared/host"

export interface CleanupOrganizationView {
  id: string
  slug: string
  name: string
  logoKey: string | null
  donationUrl: string | null
  verifiedStatus: OrgVerificationStatus
  verifiedKind: OrgVerificationKind | null
  /** Operator suspension flag (0162): a suspended org cannot be linked to a new or existing event. */
  suspended: boolean
}

export interface CleanupHostFields {
  endsAt: Date
  timezone: string | null
  visibility: EventVisibility
  coverMediaId: string | null
  coverKey: string | null
  galleryMediaIds: string[]
  donationUrl: string | null
  pageSlug: string | null
  registrationOpensAt: Date | null
  registrationClosesAt: Date | null
  organizationId: string | null
  organization: CleanupOrganizationView | null
  reminderOffsetsMin: number[] | null
  hostReplyTo: string | null
  hostReplyToVerifiedAt: Date | null
}

export interface CleanupRecord extends CleanupHostFields {
  id: string
  organizerUserId: string
  type: CleanupType
  eventKind: EventKind
  title: string
  description: string | null
  lat: number
  lng: number
  scheduledAt: Date
  status: CleanupStatus
  bring: string[] | null
  address: string | null
  addressSource: EventAddressSource | null
  capacity: number | null
  jurisdictionGeoid: string | null
  referenceCode: string | null
  createdAt: Date
  completedAt: Date | null
  going: number
  guestCount?: number
  dist: number | null
  organizer: CleanupPersonView
}

export interface LinkedReportView {
  cleanupId: string
  id: string
  category: ReportCategory
  type?: ReportType
  title: string | null
  status: ReportStatus
  lat: number
  lng: number
  addr: string | null
  thumbKey: string | null
  linkedAt: Date
}

export interface LinkedEventView {
  reportId: string
  id: string
  title: string
  eventKind: EventKind
  status: CleanupStatus
  scheduledAt: Date
  endsAt: Date | null
  timezone: string | null
  lat: number
  lng: number
  going: number
  organizer: CleanupPersonView
  linkedAt: Date
}

export interface CleanupPersonView {
  id: string
  displayName: string
  handle: string | null
  bio: string | null
  avatarUrl: string | null
  donationUrl?: string | null
}

export interface AttendeeView extends CleanupPersonView {
  isFollowing: boolean
  role: CleanupMemberRole
  slot?: { id: string; title: string } | null
}

export interface EventSlotView {
  cleanupId: string
  id: string
  title: string
  description: string | null
  capacity: number | null
  startsAt: Date | null
  endsAt: Date | null
  sortOrder: number
  claimed: number
  mine: boolean
}

export interface DesiredSlot {
  id?: string
  title: string
  description: string | null
  capacity: number | null
  startsAt: Date | null
  endsAt: Date | null
  sortOrder: number
}

export interface SlotReconcileResult {
  added: string[]
  updated: string[]
  removed: { slotId: string; title: string; claimantUserIds: string[] }[]
  rescheduled: { slotId: string; title: string; claimantUserIds: string[] }[]
}

export type ClaimSlotOutcome =
  | { kind: "claimed"; slotId: string }
  | { kind: "released" }
  | { kind: "not_found" }
  | { kind: "slot_not_found" }
  | { kind: "banned" }
  | { kind: "closed" }
  | { kind: "ended" }
  | { kind: "full" }

export interface ListAttendeesArgs {
  cleanupId: string
  viewerId: string | null
  onlyFollowed: boolean
  limit: number
}

export interface EventHostWrite {
  endsAt?: Date
  timezone?: string | null
  visibility?: EventVisibility
  coverMediaId?: string | null
  galleryMediaIds?: string[]
  donationUrl?: string | null
  pageSlug?: string | null
  registrationOpensAt?: Date | null
  registrationClosesAt?: Date | null
  organizationId?: string | null
  reminderOffsetsMin?: number[] | null
  hostReplyTo?: string | null
}

export interface CleanupIdempotency {
  key: string
  scope: string
  userOrAnon: string
}

export interface DuplicateSource {
  cleanupId: string
  ticketTypes: boolean
  questions: boolean
  page: boolean
}

export interface CreateCleanupTxArgs {
  cleanupId: string
  organizerUserId: string
  type: CleanupType
  eventKind: EventKind
  title: string
  description: string | null
  lat: number
  lng: number
  scheduledAt: Date
  status: CleanupStatus
  bring: string[] | null
  address: string | null
  addressSource: EventAddressSource | null
  jurisdictionGeoid: string | null
  jurCode: number
  linkedReportIds: string[]
  slots: DesiredSlot[]
  host: EventHostWrite & { endsAt: Date }
  idempotency?: CleanupIdempotency
  copyFrom?: DuplicateSource
}

export interface CreateCleanupOutcome {
  record: CleanupRecord
  replayed: boolean
}

export interface UpdateCleanupPatch extends EventHostWrite {
  title?: string
  description?: string | null
  eventKind?: EventKind
  type?: CleanupType
  scheduledAt?: Date
  lat?: number
  lng?: number
  address?: string | null
  addressSource?: EventAddressSource | null
  bring?: string[] | null
  jurisdictionGeoid?: string | null
}

export type JoinCleanupOutcome = "joined" | "not_found" | "banned" | "closed" | "ended"

export type LeaveCleanupOutcome = "left" | "not_found" | "closed"

export type RemoveMemberOutcome =
  | { kind: "removed"; going: number; releasedWaitlistTicketTypeIds: string[] }
  | { kind: "not_member"; going: number }
  | { kind: "closed" }
  | { kind: "not_found" }

export type CancelCleanupOutcome = "cancelled" | "already_cancelled" | "already_ended" | "not_found"

export interface NearPoint {
  lat: number
  lng: number
}

export interface CleanupBBox {
  west: number
  south: number
  east: number
  north: number
}

export interface OrganizationEventsHost {
  organization: CleanupOrganizationView
  viewerIsMember: boolean
}

export interface OrganizationEventsFilters {
  organizationId: string
  when: "upcoming" | "past"
  cursor: string | null
  limit: number
}

export interface ListCleanupsFilters {
  when: "upcoming" | "past" | "attending" | undefined
  bbox: CleanupBBox | undefined
  near: NearPoint | undefined
  cursor: string | null
  limit: number
  viewerId?: string | null
}

export interface SignupSeat {
  seatId: string
  tokenHash: string
}

export interface CleanupRepository {
  createCleanupTx(args: CreateCleanupTxArgs): Promise<CreateCleanupOutcome>
  updateCleanup(id: string, patch: UpdateCleanupPatch): Promise<boolean>
  linkReports(cleanupId: string, reportIds: string[], actorId: string | null): Promise<string[]>
  unlinkReport(cleanupId: string, reportId: string, actorId: string | null): Promise<boolean>
  reconcileLinkedReports(
    cleanupId: string,
    desiredIds: string[],
    actorId: string | null,
  ): Promise<{ added: string[]; removed: string[] }>
  loadLinkedReportsForCleanups(
    cleanupIds: string[],
    perCleanupCap?: number,
  ): Promise<Map<string, LinkedReportView[]>>
  loadLinkedEventsForReports(reportIds: string[]): Promise<Map<string, LinkedEventView[]>>
  filterVisibleReportIds(reportIds: string[]): Promise<Set<string>>
  findCleanupById(id: string, near: NearPoint | null): Promise<CleanupRecord | null>
  findCleanupByReferenceCode(code: string): Promise<CleanupRecord | null>
  findCleanupByPageSlug(slug: string): Promise<CleanupRecord | null>
  galleryKeysFor(cleanupId: string): Promise<string[]>
  loadOrganizationRef(organizationId: string): Promise<CleanupOrganizationView | null>
  findOrganizationEventsHost(
    slug: string,
    viewerId: string | null,
  ): Promise<OrganizationEventsHost | null>
  orgRoleOf(organizationId: string, userId: string): Promise<OrganizationMemberRole | null>
  standingOf(cleanupId: string, userId: string): Promise<HostStanding>
  standingsOf(cleanupIds: string[], userId: string): Promise<Map<string, HostStanding>>
  listCleanups(
    filters: ListCleanupsFilters,
  ): Promise<{ records: CleanupRecord[]; nextCursor: string | null }>
  listOrganizationEvents(
    filters: OrganizationEventsFilters,
  ): Promise<{ records: CleanupRecord[]; nextCursor: string | null }>
  isMember(cleanupId: string, userId: string): Promise<boolean>
  roleOf(cleanupId: string, userId: string): Promise<CleanupMemberRole | null>
  rolesOf(cleanupIds: string[], userId: string): Promise<Map<string, CleanupMemberRole>>
  setMemberRole(
    cleanupId: string,
    userId: string,
    role: "cohost" | "staff" | "coordinator" | "member",
  ): Promise<boolean>
  removeMember(cleanupId: string, userId: string, actorId: string): Promise<RemoveMemberOutcome>
  isBanned(cleanupId: string, userId: string): Promise<boolean>
  unbanMember(cleanupId: string, userId: string): Promise<boolean>
  listMemberIds(cleanupId: string, limit: number): Promise<string[]>
  goingCount(cleanupId: string): Promise<number>
  organizerOf(cleanupId: string): Promise<string | null>
  joinCleanupTx(cleanupId: string, userId: string, seat: SignupSeat): Promise<JoinCleanupOutcome>
  leaveCleanup(cleanupId: string, userId: string): Promise<LeaveCleanupOutcome>
  cancelCleanupTx(
    id: string,
    input: { note: string; body: string; reason: string | null; actorId: string },
  ): Promise<CancelCleanupOutcome>
  listAttendees(args: ListAttendeesArgs): Promise<AttendeeView[]>

  listSlots(cleanupId: string, viewerId: string | null): Promise<EventSlotView[]>
  loadSlotsForCleanups(
    cleanupIds: string[],
    viewerId: string | null,
  ): Promise<Map<string, EventSlotView[]>>
  slotCountsFor(cleanupIds: string[]): Promise<Map<string, number>>
  reconcileSlots(
    cleanupId: string,
    desired: DesiredSlot[],
    actorId: string | null,
  ): Promise<SlotReconcileResult>
  claimSlot(
    cleanupId: string,
    userId: string,
    slotId: string,
    seat: SignupSeat,
  ): Promise<ClaimSlotOutcome>
  releaseSlot(cleanupId: string, userId: string): Promise<ClaimSlotOutcome>
  slotOf(cleanupId: string, userId: string): Promise<string | null>
  resolveJurisdictionContact(
    geoid: string | null,
  ): Promise<{ contact: string; name: string } | null>
  appendCleanupTimeline(
    cleanupId: string,
    input: { kind: string; note: string | null; actorId: string | null },
  ): Promise<void>
}
