import type {
  BroadcastChannel,
  BroadcastKind,
  BroadcastSegment,
  BroadcastStatus,
  DeliveryFailureKind,
  DeliveryStatus,
  DeliverySuppressionReason,
} from "@civfix/shared"

export type BroadcastRecipientKind = "member" | "guest"

export interface BroadcastRecord {
  id: string
  cleanupId: string
  createdBy: string | null
  kind: BroadcastKind
  reminderOffsetMin: number | null
  status: BroadcastStatus
  subject: string | null
  bodyMd: string | null
  ctaLabel: string | null
  ctaUrl: string | null
  segment: BroadcastSegment | null
  channels: BroadcastChannel[]
  replyTo: string | null
  scheduledAt: Date | null
  plannedAt: Date | null
  startedAt: Date | null
  finishedAt: Date | null
  chunkSize: number
  chunkCount: number
  recipientCount: number
  sentCount: number
  failedCount: number
  suppressedCount: number
  contentScrubbedAt: Date | null
  createdAt: Date
  updatedAt: Date | null
}

export interface BroadcastCreateInput {
  cleanupId: string
  createdBy: string | null
  kind: BroadcastKind
  reminderOffsetMin?: number | null
  subject: string | null
  bodyMd: string | null
  ctaLabel?: string | null
  ctaUrl?: string | null
  segment: BroadcastSegment | null
  channels: BroadcastChannel[]
  replyTo?: string | null
  status?: BroadcastStatus
  scheduledAt?: Date | null
  chunkSize?: number
}

export interface BroadcastDraftPatch {
  subject?: string
  bodyMd?: string
  ctaLabel?: string | null
  ctaUrl?: string | null
  segment?: BroadcastSegment
  channels?: BroadcastChannel[]
}

export interface DeliveryRowInput {
  broadcastId: string
  chunkNo: number
  recipientKind: BroadcastRecipientKind
  userId: string | null
  guestId: string | null
  channel: BroadcastChannel
}

export interface DeliveryClaim {
  id: string
  chunkNo: number
  recipientKind: BroadcastRecipientKind
  userId: string | null
  guestId: string | null
  channel: BroadcastChannel
  attempts: number
}

export interface DeliveryOutcome {
  id: string
  status: Extract<DeliveryStatus, "sent" | "failed" | "suppressed" | "skipped" | "pending">
  suppressionReason?: DeliverySuppressionReason
  failureKind?: DeliveryFailureKind
  providerMessageId?: string
  sentAt?: Date
}

export interface DeliveryCounts {
  pending: number
  sent: number
  failed: number
  suppressed: number
  skipped: number
}

export interface MemberContact {
  userId: string
  email: string | null
  emailVerified: boolean
  displayName: string
  firstName: string
  locale: string | null
}

export interface GuestContact {
  guestId: string
  email: string | null
  name: string
}

export interface HostMessagingState {
  suspended: boolean
  emailVerified: boolean
  accountCreatedAt: Date
}

export interface EventBroadcastContext {
  cleanupId: string
  title: string
  pageSlug: string | null
  scheduledAt: Date
  endsAt: Date | null
  timezone: string | null
  address: string | null
  status: string
  organizerUserId: string
  replyTo: string | null
  replyToVerified: boolean
}

export interface DueReminder {
  cleanupId: string
  offsetMin: number
}

export interface AdminBroadcastRow extends BroadcastRecord {
  eventTitle: string | null
  createdByName: string | null
  createdByHandle: string | null
  createdByJoined: Date | null
}

export interface AdminHostRow {
  userId: string
  displayName: string
  handle: string | null
  joinedAt: Date | null
  messagingSuspended: boolean
  suspendedAt: Date | null
  suspendedById: string | null
  suspendedByName: string | null
  suspendedByHandle: string | null
  suspendedByJoined: Date | null
  broadcastCount: number
  recipientCount: number
  sentCount: number
  failedCount: number
  suppressedCount: number
  eventsMessaged: number
  lastBroadcastAt: Date | null
  sortAt: Date
}

export interface AdminHostListParams {
  q?: string
  suspended?: boolean
  windowStart: Date
  cursor: { at: Date; id: string } | null
  limit: number
}

export const CRITICAL_BROADCAST_KINDS: ReadonlySet<BroadcastKind> = new Set<BroadcastKind>([
  "event_updated",
  "event_cancelled",
])

export const HOST_COMPOSED_BROADCAST_KINDS: ReadonlySet<BroadcastKind> = new Set<BroadcastKind>([
  "host_broadcast",
  "thank_you",
])
