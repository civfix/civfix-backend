import type { BroadcastKind, BroadcastSegment, BroadcastStatus, DeliveryStatus } from "@civfix/shared"
import type { NotificationPrefsRecord } from "../notification-service.js"
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
} from "./broadcast-types.js"

export interface BroadcastListQuery {
  cleanupId: string
  status?: BroadcastStatus
  cursor: { createdAt: Date; id: string } | null
  limit: number
}

export interface DeliveryListQuery {
  broadcastId: string
  status?: DeliveryStatus
  channel?: string
  cursor: { createdAt: Date; id: string } | null
  limit: number
}

export interface DeliveryListRow {
  id: string
  channel: string
  recipientKind: "member" | "guest"
  status: DeliveryStatus
  suppressionReason: string | null
  failureKind: string | null
  attempts: number
  sentAt: Date | null
  createdAt: Date
}

export interface AdminBroadcastListQuery {
  status?: BroadcastStatus
  kind?: string
  cleanupId?: string
  createdBy?: string
  from?: Date
  to?: Date
  cursor: { createdAt: Date; id: string } | null
  limit: number
}

export interface AnnouncementListQuery {
  cleanupId: string
  cursor: { createdAt: Date; id: string } | null
  limit: number
}

export interface AudiencePageQuery {
  cleanupId: string
  segment: BroadcastSegment
  kind: BroadcastKind
  afterMember: string | null
  afterGuest: string | null
  limit: number
}

export interface AnnouncementCap {
  since: Date
  max: number
}

export interface BroadcastRepository {
  create(input: BroadcastCreateInput): Promise<BroadcastRecord>
  createIfAbsent(input: BroadcastCreateInput): Promise<BroadcastRecord | null>
  createAnnouncementUnderCap(
    input: BroadcastCreateInput,
    cap: AnnouncementCap,
  ): Promise<BroadcastRecord | null>

  findById(broadcastId: string): Promise<BroadcastRecord | null>
  findForEvent(cleanupId: string, broadcastId: string): Promise<BroadcastRecord | null>
  list(query: BroadcastListQuery): Promise<BroadcastRecord[]>
  listAnnouncements(query: AnnouncementListQuery): Promise<BroadcastRecord[]>
  countAnnouncementsSince(cleanupId: string, since: Date): Promise<number>
  listAdmin(query: AdminBroadcastListQuery): Promise<AdminBroadcastRow[]>
  listAdminHosts(params: AdminHostListParams): Promise<AdminHostRow[]>

  updateDraft(
    cleanupId: string,
    broadcastId: string,
    patch: BroadcastDraftPatch,
  ): Promise<BroadcastRecord | null>
  deleteDraft(cleanupId: string, broadcastId: string): Promise<boolean>

  transition(
    broadcastId: string,
    from: readonly BroadcastStatus[],
    to: BroadcastStatus,
    fields?: {
      scheduledAt?: Date | null
      startedAt?: Date | null
      finishedAt?: Date | null
      replyTo?: string | null
    },
  ): Promise<BroadcastRecord | null>

  markPlanned(
    broadcastId: string,
    args: { recipientCount: number; plannedAt: Date },
  ): Promise<boolean>

  listStaleSending(staleBefore: Date, limit: number): Promise<string[]>
  listDueScheduled(now: Date, limit: number): Promise<string[]>

  insertDeliveries(rows: readonly DeliveryRowInput[]): Promise<number>
  claimChunk(args: {
    broadcastId: string
    chunkNo: number
    staleBefore: Date
    maxAttempts: number
    limit: number
  }): Promise<DeliveryClaim[]>
  applyDeliveryOutcomes(outcomes: readonly DeliveryOutcome[]): Promise<void>
  releaseClaims(deliveryIds: readonly string[]): Promise<void>
  listPendingChunks(broadcastId: string): Promise<number[]>
  failExhausted(broadcastId: string, maxAttempts: number): Promise<number>
  suppressRemaining(broadcastId: string, reason: string): Promise<number>
  deliveryCounts(broadcastId: string): Promise<DeliveryCounts>
  refreshCounts(broadcastId: string): Promise<BroadcastRecord | null>
  listDeliveries(query: DeliveryListQuery): Promise<DeliveryListRow[]>

  memberContacts(userIds: readonly string[]): Promise<Map<string, MemberContact>>
  pushPrefs(userIds: readonly string[]): Promise<Map<string, NotificationPrefsRecord>>
  guestContacts(guestIds: readonly string[]): Promise<Map<string, GuestContact>>
  ticketTypeNames(args: {
    cleanupId: string
    userIds: readonly string[]
    guestIds: readonly string[]
  }): Promise<Map<string, string>>

  eventContext(cleanupId: string): Promise<EventBroadcastContext | null>
  hostMessagingState(userId: string): Promise<HostMessagingState | null>
  setHostMessagingSuspended(userId: string, suspended: boolean): Promise<boolean>

  isEmailSuppressed(emailHash: string): Promise<boolean>
  suppressedEmailHashes(emailHashes: readonly string[]): Promise<Set<string>>
  suppressEmail(emailHash: string, reason: "hard_bounce" | "complaint" | "manual"): Promise<void>

  recordUnsubscribe(args: {
    scope: "event" | "global"
    cleanupId: string | null
    subjectKind: "user" | "guest"
    subjectId: string
    reason: "one_click" | "manual" | "complaint"
  }): Promise<void>

  setEventMute(cleanupId: string, userId: string, muted: boolean): Promise<void>
  isEventMuted(cleanupId: string, userId: string): Promise<boolean>

  listDueReminders(args: {
    now: Date
    staleAfter: Date
    defaultOffsets: readonly number[]
    limit: number
  }): Promise<DueReminder[]>

  audiencePage(query: AudiencePageQuery): Promise<{ members: string[]; guests: string[] }>

  scrubBroadcastContent(cutoff: Date, batchSize: number): Promise<number>
  deleteOldDeliveries(cutoff: Date, batchSize: number): Promise<number>
}
