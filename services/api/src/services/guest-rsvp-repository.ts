import type { CleanupStatus, EventVisibility, GuestContactChannel } from "@civfix/shared"
import type { KeysetCursor } from "../db/cursor-helpers.js"

export interface GuestOtpRecord {
  id: string
  cleanupId: string
  channel: GuestContactChannel
  contact: string
  name: string
  codeHash: string
}

export interface GuestRosterRow {
  id: string
  name: string
  channel: GuestContactChannel
  email: string | null
  phone: string | null
  verifiedAt: Date
  cancelledAt: Date | null
}

export interface GuestRecipient {
  id: string
  name: string
  channel: GuestContactChannel
  email: string | null
  phone: string | null
}

export interface GuestNoticeTarget {
  id: string
  cleanupId: string
  name: string
  email: string | null
  cancelledAt: Date | null
  contactScrubbedAt: Date | null
}

export interface GuestEventView {
  id: string
  title: string
  status: CleanupStatus
  visibility: EventVisibility
  scheduledAt: Date
  endsAt: Date | null
  address: string | null
  timezone: string | null
  lat: number
  lng: number
}

export interface InsertGuestOtpArgs {
  cleanupId: string
  channel: GuestContactChannel
  contact: string
  name: string
  codeHash: string
  expiresAt: Date
}

export interface UpsertGuestArgs {
  cleanupId: string
  name: string
  channel: GuestContactChannel
  contactKey: string
  email: string | null
  phone: string | null
  manageTokenHash: string
  now: Date
}

export interface GuestRsvpRepository {
  findEvent(cleanupId: string): Promise<GuestEventView | null>
  countActiveGuests(cleanupId: string): Promise<number>
  goingCount(cleanupId: string): Promise<number>
  isPhoneOptedOut(phone: string): Promise<boolean>
  recordPhoneOptOut(phone: string): Promise<void>
  invalidateActiveOtps(cleanupId: string, contact: string, now: Date): Promise<void>
  insertOtp(args: InsertGuestOtpArgs): Promise<void>
  findLatestActiveOtp(cleanupId: string, contact: string, now: Date): Promise<GuestOtpRecord | null>
  incrementOtpAttempts(otpId: string): Promise<number>
  markOtpConsumed(otpId: string, now: Date): Promise<boolean>
  /** `created` is true when this call inserted the row rather than re-verifying an active one. */
  upsertVerifiedGuest(args: UpsertGuestArgs): Promise<{ id: string; created: boolean }>
  findGuestByManageTokenHash(
    hash: string,
  ): Promise<{ id: string; cleanupId: string; cancelledAt: Date | null } | null>
  findGuestForNotice(guestId: string): Promise<GuestNoticeTarget | null>
  cancelGuest(guestId: string, now: Date): Promise<string[]>
  listGuests(args: {
    cleanupId: string
    cursor: KeysetCursor | null
    limit: number
  }): Promise<{ rows: GuestRosterRow[]; nextCursor: string | null }>
  listContactableGuests(cleanupId: string, limit: number): Promise<GuestRecipient[]>
  scrubExpiredGuestContacts(args: { cutoff: Date; now: Date; batchSize: number }): Promise<number>
  deleteStaleOtps(args: { cutoff: Date; batchSize: number }): Promise<number>
}
