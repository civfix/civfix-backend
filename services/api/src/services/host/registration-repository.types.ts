import type {
  CheckinMethod,
  CheckinOutcome,
  ConsentSurface,
  EventPageBlock,
  EventPageSeo,
  EventQuestionCondition,
  EventQuestionKind,
  EventQuestionOption,
  EventPageStatus,
  RegisterOutcome,
  RegistrationRosterFilter,
  RegistrationRosterSort,
  RegistrationSource,
  RegistrationStatus,
  SeatStatus,
  ThemeAccent,
  TicketTypeVisibility,
  WaitlistClaimOutcome,
  WaitlistStatus,
} from "@civfix/shared"
import type { CleanupStatus, EventVisibility } from "@civfix/shared"

export type RegistrationSubject =
  | { kind: "user"; userId: string }
  | { kind: "guest"; guestId: string }

export interface TicketTypeRecord {
  id: string
  cleanupId: string
  name: string
  description: string | null
  capacity: number | null
  reservedSeats: number
  sold: number
  salesOpensAt: Date | null
  salesClosesAt: Date | null
  visibility: TicketTypeVisibility
  accessCodeSet: boolean
  maxPartySize: number
  sortOrder: number
  waitlistEnabled: boolean
  questionIds: string[]
}

export interface TicketTypeWriteArgs {
  cleanupId: string
  name: string
  description: string | null
  capacity: number | null
  salesOpensAt: Date | null
  salesClosesAt: Date | null
  visibility: TicketTypeVisibility
  accessCodeHash: string | null
  clearAccessCode: boolean
  maxPartySize: number
  sortOrder: number | null
  waitlistEnabled: boolean
  questionIds: string[] | null
  now: Date
}

export type TicketTypeCapacityFit =
  | { ok: true }
  | { ok: false; eventCapacity: number; used: number }

export type CreateTicketTypeOutcome =
  | { kind: "created"; record: TicketTypeRecord }
  | { kind: "name_taken" }
  | { kind: "too_many" }
  | { kind: "capacity_exceeded"; eventCapacity: number; used: number }
  | { kind: "sales_window" }
  | { kind: "not_found" }

export type UpdateTicketTypeOutcome =
  | { kind: "updated"; record: TicketTypeRecord }
  | { kind: "name_taken" }
  | { kind: "capacity_below_reserved"; reservedSeats: number }
  | { kind: "capacity_exceeded"; eventCapacity: number; used: number }
  | { kind: "sales_window" }
  | { kind: "not_found" }

export type DeleteTicketTypeOutcome =
  | { kind: "deleted" }
  | { kind: "in_use" }
  | { kind: "not_found" }

export type ReorderTicketTypesOutcome =
  | { kind: "reordered"; items: TicketTypeRecord[] }
  | { kind: "mismatch" }

export interface QuestionRecord {
  id: string
  cleanupId: string
  ticketTypeId: string | null
  kind: EventQuestionKind
  prompt: string
  helpText: string | null
  required: boolean
  options: EventQuestionOption[]
  maxSelections: number | null
  consentText: string | null
  showIf: EventQuestionCondition | null
  sortOrder: number
  archivedAt: Date | null
}

export interface DesiredQuestion {
  id: string | null
  ticketTypeId: string | null
  kind: EventQuestionKind
  prompt: string
  helpText: string | null
  required: boolean
  options: EventQuestionOption[]
  maxSelections: number | null
  consentText: string | null
  showIf: EventQuestionCondition | null
  sortOrder: number
}

export interface AnswerWrite {
  questionId: string
  valueText: string | null
  valueJson: unknown | null
}

export interface AnswerRecord {
  questionId: string
  prompt: string
  valueText: string | null
  valueJson: unknown | null
  scrubbedAt: Date | null
}

export interface RegistrantIdentity {
  userId: string | null
  displayName: string | null
  handle: string | null
  bio: string | null
  avatarUrl: string | null
  deletedAt: Date | null
}

export interface SeatRecord {
  id: string
  registrationId: string
  seatIndex: number
  attendeeName: string | null
  status: SeatStatus
  checkedInAt: Date | null
  checkedInBy: string | null
  checkinMethod: CheckinMethod | null
  checkinCoarsenedAt: Date | null
  noShowAt: Date | null
}

export interface RegistrationRecord {
  id: string
  cleanupId: string
  ticketTypeId: string | null
  ticketTypeName: string | null
  userId: string | null
  guestId: string | null
  guestName: string | null
  identity: RegistrantIdentity | null
  partySize: number
  status: RegistrationStatus
  source: RegistrationSource
  hostNote: string | null
  registeredAt: Date
  cancelledAt: Date | null
  checkedInAt: Date | null
  slotId: string | null
  slotTitle: string | null
  seats: SeatRecord[]
  answersPreview: string | null
}

export interface EventRegistrationContext {
  cleanupId: string
  status: CleanupStatus
  visibility: EventVisibility
  capacity: number | null
  title: string
  description: string | null
  referenceCode: string | null
  lat: number
  lng: number
  scheduledAt: Date
  endsAt: Date | null
  timezone: string | null
  address: string | null
  registrationOpensAt: Date | null
  registrationClosesAt: Date | null
  pageSlug: string | null
  organizerUserId: string
  organizationId: string | null
}

export interface ConsentWrite {
  termsVersion: string
  disclosureVersion: string
  hostContactOptIn: boolean
  smsOptIn: boolean | null
  surface: ConsentSurface | null
}

export interface SeatDraft {
  id: string
  attendeeName: string | null
  tokenHash: string
}

export interface RegisterTxArgs {
  cleanupId: string
  subject: RegistrationSubject
  ticketTypeId: string | null
  seats: SeatDraft[]
  accessCodeHash: string | null
  answers: AnswerWrite[]
  consent: ConsentWrite | null
  slotId: string | null
  source: RegistrationSource
  idempotencyKey: string
  idempotencyOwner?: string
  waitlistId: string | null
  now: Date
}

export interface WalkupCheckIn {
  actorId: string
  method: CheckinMethod
}

export interface WalkupRegisterArgs {
  cleanupId: string
  name: string
  manageTokenHash: string
  ticketTypeId: string | null
  seats: SeatDraft[]
  idempotencyKey: string
  idempotencyOwner: string
  now: Date
  checkIn?: WalkupCheckIn | null
}

export interface RegisterSnapshot {
  registrationId: string
}

export type RegisterTxOutcome =
  | { kind: "registered"; registration: RegistrationRecord }
  | { kind: "replayed"; registration: RegistrationRecord | null }
  | { kind: Exclude<RegisterOutcome, "registered" | "replayed" | "waitlisted"> }

export interface RosterQuery {
  cleanupId: string
  filter: RegistrationRosterFilter
  ticketTypeId: string | null
  slotId: string | null
  sort: RegistrationRosterSort
  q: string | null
  cursor: string | null
  limit: number
  withTotal: boolean
}

export interface RosterPage {
  rows: RegistrationRecord[]
  nextCursor: string | null
  total?: number
}

export type CancelRegistrationOutcome =
  | { kind: "cancelled"; registration: RegistrationRecord; ticketTypeId: string | null }
  | { kind: "already_cancelled" }
  | { kind: "not_found" }

/** A ban also withdraws the user's waitlist places; these types had offered seats released. */
export type RemoveRegistrationOutcome = CancelRegistrationOutcome & {
  releasedWaitlistTicketTypeIds: string[]
}

export type TransferRegistrationOutcome =
  | { kind: "transferred"; registration: RegistrationRecord; previousTicketTypeId: string | null }
  | { kind: "full" }
  | { kind: "party_too_large" }
  | { kind: "same_type" }
  | { kind: "ticket_type_not_found" }
  | { kind: "not_found" }

export interface WaitlistRecord {
  id: string
  cleanupId: string
  ticketTypeId: string
  ticketTypeName: string | null
  userId: string | null
  guestId: string | null
  guestName: string | null
  identity: RegistrantIdentity | null
  partySize: number
  status: WaitlistStatus
  position: number | null
  createdAt: Date
  offeredAt: Date | null
  claimExpiresAt: Date | null
}

export type JoinWaitlistOutcome =
  | { kind: "joined"; entry: WaitlistRecord }
  | { kind: "already_waiting"; entry: WaitlistRecord }
  | { kind: "already_registered" }
  | { kind: "access_code_required" }
  | { kind: "access_code_invalid" }
  | { kind: "waitlist_disabled" }
  | { kind: "ticket_type_not_found" }
  | { kind: "banned" }
  | { kind: "closed" }
  | { kind: "ended" }
  | { kind: "not_found" }

export interface WaitlistOffer {
  waitlistId: string
  cleanupId: string
  ticketTypeId: string
  userId: string | null
  guestId: string | null
  partySize: number
  claimExpiresAt: Date
}

export type ClaimWaitlistOutcome =
  | { kind: "claimed"; registration: RegistrationRecord }
  | { kind: Exclude<WaitlistClaimOutcome, "claimed"> }

export interface CheckinResultRecord {
  outcome: CheckinOutcome
  firstTime: boolean
  seat: SeatRecord | null
  registration: RegistrationRecord | null
  attendeeName: string | null
  ticketTypeName: string | null
  partySize: number | null
  checkedInAt: Date | null
}

export interface CheckinCountersRecord {
  registered: number
  checkedIn: number
  waitlisted: number
  noShow: number
  capacity: number | null
  byTicketType: {
    ticketTypeId: string
    name: string
    registered: number
    checkedIn: number
    waitlisted: number
    capacity: number | null
  }[]
  arrivals: { at: Date; count: number }[]
}

export interface PageRecord {
  cleanupId: string
  slug: string | null
  status: EventPageStatus
  themeAccent: ThemeAccent
  blocks: EventPageBlock[]
  seo: EventPageSeo
  coverMediaId: string | null
  coverKey: string | null
  visibility: EventVisibility
  publishedAt: Date | null
  updatedAt: Date | null
  flaggedAt: Date | null
  flagReason: string | null
  viewCount: number
}

export interface SavePageArgs {
  cleanupId: string
  slug: string | null | undefined
  themeAccent: ThemeAccent | undefined
  blocks: EventPageBlock[]
  blockMediaIds: string[]
  seo: EventPageSeo | undefined
  coverMediaId: string | null | undefined
  now: Date
}

export type SavePageOutcome =
  | { kind: "saved"; record: PageRecord }
  | { kind: "slug_taken" }
  | { kind: "cover_not_found" }
  | { kind: "block_media_not_found" }
  | { kind: "not_found" }

export type PublishPageOutcome =
  | { kind: "published"; record: PageRecord }
  | { kind: "flagged" }
  | { kind: "not_found" }

export interface PublicPageRecord {
  page: PageRecord
  event: EventRegistrationContext
  ticketTypes: TicketTypeRecord[]
  questions: QuestionRecord[]
  organizationId: string | null
  donationUrl: string | null
  logoKey: string | null
}

export interface HostedEventCounts {
  registeredCount: number
  waitlistCount: number
  checkedInCount: number
}

export interface HostRegistrationRepository {
  eventContext(cleanupId: string): Promise<EventRegistrationContext | null>

  listTicketTypes(cleanupId: string): Promise<TicketTypeRecord[]>
  listTicketTypesFor(cleanupIds: readonly string[]): Promise<Map<string, TicketTypeRecord[]>>
  getTicketType(cleanupId: string, ticketTypeId: string): Promise<TicketTypeRecord | null>
  ticketTypeIdsMatchingAccessCode(cleanupId: string, accessCodeHash: string): Promise<string[]>
  createTicketType(args: TicketTypeWriteArgs): Promise<CreateTicketTypeOutcome>
  updateTicketType(
    args: TicketTypeWriteArgs & { ticketTypeId: string; patch: readonly string[] },
  ): Promise<UpdateTicketTypeOutcome>
  deleteTicketType(cleanupId: string, ticketTypeId: string): Promise<DeleteTicketTypeOutcome>
  reorderTicketTypes(
    cleanupId: string,
    ticketTypeIds: readonly string[],
    now: Date,
  ): Promise<ReorderTicketTypesOutcome>

  listQuestions(
    cleanupId: string,
    opts?: { ticketTypeId?: string | null; includeArchived?: boolean },
  ): Promise<QuestionRecord[]>
  reconcileQuestions(
    cleanupId: string,
    desired: readonly DesiredQuestion[],
    now: Date,
  ): Promise<QuestionRecord[]>

  registerWalkupTx(args: WalkupRegisterArgs): Promise<RegisterTxOutcome>
  registerTx(args: RegisterTxArgs): Promise<RegisterTxOutcome>
  findRegistration(cleanupId: string, registrationId: string): Promise<RegistrationRecord | null>
  findMyRegistration(
    cleanupId: string,
    subject: RegistrationSubject,
  ): Promise<RegistrationRecord | null>
  findRegistrationsFor(
    cleanupIds: readonly string[],
    userId: string,
  ): Promise<Map<string, RegistrationRecord>>
  listRoster(query: RosterQuery): Promise<RosterPage>
  listAnswers(cleanupId: string, registrationId: string): Promise<AnswerRecord[]>
  setHostNote(cleanupId: string, registrationId: string, note: string | null): Promise<boolean>
  cancelRegistration(args: {
    cleanupId: string
    registrationId: string
    actorId: string | null
    now: Date
  }): Promise<CancelRegistrationOutcome>
  removeRegistration(args: {
    cleanupId: string
    registrationId: string
    actorId: string
    ban: boolean
    now: Date
  }): Promise<RemoveRegistrationOutcome>
  transferRegistration(args: {
    cleanupId: string
    registrationId: string
    ticketTypeId: string
    now: Date
  }): Promise<TransferRegistrationOutcome>

  joinWaitlist(args: {
    cleanupId: string
    ticketTypeId: string
    subject: RegistrationSubject
    partySize: number
    accessCodeHash: string | null
    now: Date
  }): Promise<JoinWaitlistOutcome>
  leaveWaitlist(args: {
    cleanupId: string
    ticketTypeId: string | null
    subject: RegistrationSubject
    now: Date
  }): Promise<{ left: number; releasedTicketTypeIds: string[] }>
  listWaitlist(args: {
    cleanupId: string
    ticketTypeId: string | null
    status: WaitlistStatus | null
    cursor: string | null
    limit: number
  }): Promise<{ rows: WaitlistRecord[]; nextCursor: string | null }>
  findWaitlistEntry(cleanupId: string, waitlistId: string): Promise<WaitlistRecord | null>
  offerNextWaitlistEntry(args: {
    ticketTypeId: string
    now: Date
    claimWindowMs: number
  }): Promise<WaitlistOffer | null>
  offerWaitlistEntry(args: {
    cleanupId: string
    waitlistId: string
    now: Date
    claimWindowMs: number
  }): Promise<WaitlistOffer | null>
  expireWaitlistOffers(args: { now: Date; limit: number }): Promise<string[]>
  claimWaitlistOffer(args: {
    cleanupId: string
    waitlistId: string
    subject: RegistrationSubject | null
    seats: SeatDraft[]
    now: Date
  }): Promise<ClaimWaitlistOutcome>
  ticketTypeIdsWithWaiting(cleanupId: string): Promise<string[]>

  checkInByToken(args: {
    cleanupId: string
    tokenHash: string
    actorId: string
    method: CheckinMethod
    now: Date
  }): Promise<CheckinResultRecord>
  checkInSeat(args: {
    cleanupId: string
    seatId: string
    actorId: string
    method: CheckinMethod
    now: Date
  }): Promise<CheckinResultRecord>
  undoCheckIn(args: { cleanupId: string; seatId: string }): Promise<SeatRecord | null>
  markNoShows(args: {
    cleanupId: string
    seatIds: readonly string[] | null
    now: Date
  }): Promise<number>
  sweepNoShows(args: { now: Date; limit: number }): Promise<number>
  checkinCounters(cleanupId: string): Promise<CheckinCountersRecord>

  getPage(cleanupId: string): Promise<PageRecord | null>
  savePage(args: SavePageArgs): Promise<SavePageOutcome>
  publishPage(args: {
    cleanupId: string
    published: boolean
    actorId: string
    now: Date
  }): Promise<PublishPageOutcome>
  slugTaken(cleanupId: string, slug: string): Promise<boolean>
  mediaKeysFor(cleanupId: string, mediaIds: readonly string[]): Promise<Map<string, string>>
  getPublicPage(slug: string): Promise<PublicPageRecord | null>

  hostedEventCounts(cleanupIds: readonly string[]): Promise<Map<string, HostedEventCounts>>
}
