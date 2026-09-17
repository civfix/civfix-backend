import { randomUUID } from "node:crypto"
import type { GuestContactChannel } from "@civfix/shared"
import { encodeTimeCursor, pageWith, type TimeCursor } from "../../src/db/cursor-helpers.js"
import type {
  GuestEventView,
  GuestNoticeTarget,
  GuestOtpRecord,
  GuestRecipient,
  GuestRosterRow,
  GuestRsvpRepository,
  InsertGuestOtpArgs,
  UpsertGuestArgs,
} from "../../src/services/guest-rsvp-service.js"
import type { InMemoryHostRegistrationRepository } from "../../src/services/host/registration-repository.memory.js"
import type { GuestCountSource } from "./cleanups.js"

export interface StoredGuest {
  id: string
  cleanupId: string
  name: string
  channel: GuestContactChannel
  email: string | null
  phone: string | null
  contactKey: string | null
  manageTokenHash: string
  verifiedAt: Date
  cancelledAt: Date | null
  contactScrubbedAt: Date | null
  createdAt: Date
}

export interface StoredGuestOtp {
  id: string
  cleanupId: string
  channel: GuestContactChannel
  contact: string
  name: string
  codeHash: string
  expiresAt: Date
  attempts: number
  consumedAt: Date | null
  createdAt: Date
}

export interface InMemoryGuestRsvpOptions {
  now?: () => number
}

export class InMemoryGuestRsvpRepository implements GuestRsvpRepository, GuestCountSource {
  readonly events = new Map<string, GuestEventView>()
  readonly guests: StoredGuest[] = []
  readonly otps: StoredGuestOtp[] = []
  readonly optOuts = new Set<string>()
  readonly memberCounts = new Map<string, number>()

  registrations: InMemoryHostRegistrationRepository | null = null

  private readonly clock: () => number
  private seq = 0

  constructor(opts: InMemoryGuestRsvpOptions = {}) {
    this.clock = opts.now ?? (() => Date.now())
  }

  private nextCreatedAt(): Date {
    this.seq += 1
    return new Date(this.clock() + this.seq)
  }

  seedEvent(event: Partial<GuestEventView> & { id: string }): GuestEventView {
    const full: GuestEventView = {
      id: event.id,
      title: event.title ?? "Beach cleanup",
      status: event.status ?? "upcoming",
      scheduledAt: event.scheduledAt ?? new Date(this.clock() + 86_400_000),
      endsAt: event.endsAt ?? null,
      address: event.address ?? "123 Ocean Ave",
      timezone: event.timezone ?? "America/Los_Angeles",
      lat: event.lat ?? 33.99,
      lng: event.lng ?? -118.47,
    }
    this.events.set(full.id, full)
    return full
  }

  activeGuestCount(cleanupId: string): number {
    return this.guests.filter((g) => g.cleanupId === cleanupId && g.cancelledAt === null).length
  }

  findEvent(cleanupId: string): Promise<GuestEventView | null> {
    return Promise.resolve(this.events.get(cleanupId) ?? null)
  }

  countActiveGuests(cleanupId: string): Promise<number> {
    return Promise.resolve(this.activeGuestCount(cleanupId))
  }

  goingCount(cleanupId: string): Promise<number> {
    return Promise.resolve((this.memberCounts.get(cleanupId) ?? 0) + this.activeGuestCount(cleanupId))
  }

  isPhoneOptedOut(phone: string): Promise<boolean> {
    return Promise.resolve(this.optOuts.has(phone))
  }

  recordPhoneOptOut(phone: string): Promise<void> {
    this.optOuts.add(phone)
    return Promise.resolve()
  }

  invalidateActiveOtps(cleanupId: string, contact: string, now: Date): Promise<void> {
    for (const otp of this.otps) {
      if (otp.cleanupId === cleanupId && otp.contact === contact && otp.consumedAt === null) {
        otp.consumedAt = now
      }
    }
    return Promise.resolve()
  }

  insertOtp(args: InsertGuestOtpArgs): Promise<void> {
    this.otps.push({
      id: randomUUID(),
      cleanupId: args.cleanupId,
      channel: args.channel,
      contact: args.contact,
      name: args.name,
      codeHash: args.codeHash,
      expiresAt: args.expiresAt,
      attempts: 0,
      consumedAt: null,
      createdAt: this.nextCreatedAt(),
    })
    return Promise.resolve()
  }

  findLatestActiveOtp(
    cleanupId: string,
    contact: string,
    now: Date,
  ): Promise<GuestOtpRecord | null> {
    const matches = this.otps
      .filter(
        (o) =>
          o.cleanupId === cleanupId &&
          o.contact === contact &&
          o.consumedAt === null &&
          o.expiresAt.getTime() > now.getTime(),
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    const row = matches[0]
    if (row === undefined) return Promise.resolve(null)
    return Promise.resolve({
      id: row.id,
      cleanupId: row.cleanupId,
      channel: row.channel,
      contact: row.contact,
      name: row.name,
      codeHash: row.codeHash,
    })
  }

  incrementOtpAttempts(otpId: string): Promise<number> {
    const row = this.otps.find((o) => o.id === otpId)
    if (row === undefined) return Promise.resolve(0)
    row.attempts += 1
    return Promise.resolve(row.attempts)
  }

  markOtpConsumed(otpId: string, now: Date): Promise<boolean> {
    const row = this.otps.find((o) => o.id === otpId)
    if (row === undefined || row.consumedAt !== null) return Promise.resolve(false)
    row.consumedAt = now
    return Promise.resolve(true)
  }

  upsertVerifiedGuest(args: UpsertGuestArgs): Promise<{ id: string }> {
    const existing = this.guests.find(
      (g) =>
        g.cleanupId === args.cleanupId && g.cancelledAt === null && g.contactKey === args.contactKey,
    )
    if (existing !== undefined) {
      existing.name = args.name
      existing.channel = args.channel
      existing.email = args.email
      existing.phone = args.phone
      existing.manageTokenHash = args.manageTokenHash
      existing.verifiedAt = args.now
      existing.contactScrubbedAt = null
      return Promise.resolve({ id: existing.id })
    }
    const row: StoredGuest = {
      id: randomUUID(),
      cleanupId: args.cleanupId,
      name: args.name,
      channel: args.channel,
      email: args.email,
      phone: args.phone,
      contactKey: args.contactKey,
      manageTokenHash: args.manageTokenHash,
      verifiedAt: args.now,
      cancelledAt: null,
      contactScrubbedAt: null,
      createdAt: this.nextCreatedAt(),
    }
    this.guests.push(row)
    return Promise.resolve({ id: row.id })
  }

  findGuestByManageTokenHash(
    hash: string,
  ): Promise<{ id: string; cleanupId: string; cancelledAt: Date | null } | null> {
    const row = this.guests.find((g) => g.manageTokenHash === hash)
    if (row === undefined) return Promise.resolve(null)
    return Promise.resolve({ id: row.id, cleanupId: row.cleanupId, cancelledAt: row.cancelledAt })
  }

  findGuestForNotice(guestId: string): Promise<GuestNoticeTarget | null> {
    const row = this.guests.find((g) => g.id === guestId)
    if (row === undefined) return Promise.resolve(null)
    return Promise.resolve({
      id: row.id,
      cleanupId: row.cleanupId,
      name: row.name,
      email: row.email,
      cancelledAt: row.cancelledAt,
      contactScrubbedAt: row.contactScrubbedAt,
    })
  }

  releaseOnCancel: string[] = []

  async cancelGuest(guestId: string, now: Date): Promise<string[]> {
    const row = this.guests.find((g) => g.id === guestId)
    if (row === undefined || row.cancelledAt !== null) return []
    row.cancelledAt = now
    row.email = null
    row.phone = null
    row.contactKey = null
    row.contactScrubbedAt ??= now
    const released = await this.cascadeGuestCancel(guestId, now)
    return released.length > 0 ? released : [...this.releaseOnCancel]
  }

  private async cascadeGuestCancel(guestId: string, now: Date): Promise<string[]> {
    const repo = this.registrations
    if (repo === null) return []
    const released: string[] = []
    for (const registration of [...repo.registrations.values()]) {
      if (registration.guestId !== guestId || registration.status !== "registered") continue
      await repo.cancelRegistration({
        cleanupId: registration.cleanupId,
        registrationId: registration.id,
        actorId: null,
        now,
      })
      if (registration.ticketTypeId !== null) released.push(registration.ticketTypeId)
      for (const seat of registration.seats) seat.attendeeName = null
      for (const answer of registration.answers) {
        answer.valueText = null
        answer.valueJson = null
        answer.scrubbedAt = now
      }
    }
    for (const entry of repo.waitlist.values()) {
      if (entry.guestId !== guestId) continue
      if (entry.status !== "waiting" && entry.status !== "offered") continue
      if (entry.status === "offered") {
        const type = repo.ticketTypes.get(entry.ticketTypeId)
        if (type !== undefined) {
          type.reservedSeats = Math.max(type.reservedSeats - entry.partySize, 0)
        }
        released.push(entry.ticketTypeId)
      }
      entry.status = "cancelled"
    }
    return [...new Set(released)]
  }

  listGuests(args: {
    cleanupId: string
    cursor: TimeCursor | null
    limit: number
  }): Promise<{ rows: GuestRosterRow[]; nextCursor: string | null }> {
    const cursor = args.cursor
    const ordered = this.guests
      .filter((g) => g.cleanupId === args.cleanupId)
      .sort(
        (a, b) =>
          b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
      )
      .filter((g) => {
        if (cursor === null) return true
        const at = g.createdAt.getTime()
        const cut = cursor.at.getTime()
        return at < cut || (at === cut && g.id < cursor.id)
      })
    const { items, nextCursor } = pageWith(ordered, args.limit, (last) =>
      encodeTimeCursor({ at: last.createdAt, id: last.id }),
    )
    return Promise.resolve({
      rows: items.map((g) => ({
        id: g.id,
        name: g.name,
        channel: g.channel,
        email: g.email,
        phone: g.phone,
        verifiedAt: g.verifiedAt,
        cancelledAt: g.cancelledAt,
      })),
      nextCursor,
    })
  }

  listContactableGuests(cleanupId: string, limit: number): Promise<GuestRecipient[]> {
    const rows = this.guests
      .filter(
        (g) =>
          g.cleanupId === cleanupId &&
          g.cancelledAt === null &&
          g.contactScrubbedAt === null &&
          (g.email !== null || g.phone !== null) &&
          (g.phone === null || !this.optOuts.has(g.phone)),
      )
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, limit)
      .map((g) => ({
        id: g.id,
        name: g.name,
        channel: g.channel,
        email: g.email,
        phone: g.phone,
      }))
    return Promise.resolve(rows)
  }

  scrubExpiredGuestContacts(args: {
    cutoff: Date
    now: Date
    batchSize: number
  }): Promise<number> {
    let scrubbed = 0
    for (const guest of this.guests) {
      if (scrubbed >= args.batchSize) break
      if (guest.contactScrubbedAt !== null) continue
      if (guest.email === null && guest.phone === null && guest.contactKey === null) continue
      const event = this.events.get(guest.cleanupId)
      if (event === undefined) continue
      const expired =
        event.scheduledAt.getTime() < args.cutoff.getTime() ||
        (event.status === "cancelled" && guest.createdAt.getTime() < args.cutoff.getTime())
      if (!expired) continue
      guest.email = null
      guest.phone = null
      guest.contactKey = null
      guest.contactScrubbedAt = args.now
      scrubbed += 1
    }
    return Promise.resolve(scrubbed)
  }

  deleteStaleOtps(args: { cutoff: Date; batchSize: number }): Promise<number> {
    const doomed = this.otps
      .filter((o) => o.createdAt.getTime() < args.cutoff.getTime())
      .slice(0, args.batchSize)
    for (const otp of doomed) {
      const idx = this.otps.indexOf(otp)
      if (idx >= 0) this.otps.splice(idx, 1)
    }
    return Promise.resolve(doomed.length)
  }
}
