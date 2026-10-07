import { avatarGradient } from "@civfix/shared"
import type {
  AttendeeDTO,
  CleanupDTO,
  CleanupMemberRole,
  EventSlotDTO,
  HostCapability,
  LinkedEventRef,
  LinkedReportRef,
  CleanupOrganizationRef,
  PersonDTO,
} from "@civfix/shared"
import type {
  AttendeeView,
  CleanupOrganizationView,
  CleanupPersonView,
  CleanupRecord,
  EventSlotView,
  LinkedEventView,
  LinkedReportView,
} from "./cleanup-repository.js"
import { officialPersonFlag } from "../auth/official-account.js"

export const CLEANUPS_DEFAULT_LIMIT = 20

export const ATTENDEES_DEFAULT_LIMIT = 50

export const THREAD_SIGNAL_MEMBER_CAP = 500

export const LINKED_REPORTS_LIST_PREVIEW = 6

export function toAttendeePersonDTO(view: CleanupPersonView, isFollowing: boolean): PersonDTO {
  return {
    id: view.id,
    name: view.displayName,
    handle: view.handle,
    bio: view.bio,
    avatar: avatarGradient(view.id),
    ...(view.avatarUrl !== null ? { avatarUrl: view.avatarUrl } : {}),
    followers: 0,
    following: 0,
    isFollowing,
    ...(view.donationUrl !== undefined && view.donationUrl !== null
      ? { donationUrl: view.donationUrl }
      : {}),
    ...(view.identityHidden === true ? {} : officialPersonFlag(view.id)),
  }
}

function toOrganizerPerson(view: CleanupPersonView): PersonDTO {
  return toAttendeePersonDTO(view, false)
}

export function toAttendeeDTO(view: AttendeeView, isFollowing: boolean): AttendeeDTO {
  return {
    ...toAttendeePersonDTO(view, isFollowing),
    role: view.role,
    ...(view.slot !== undefined ? { slot: view.slot } : {}),
  }
}

export function toEventSlotDTO(view: EventSlotView): EventSlotDTO {
  return {
    id: view.id,
    title: view.title,
    ...(view.description !== null ? { description: view.description } : {}),
    ...(view.capacity !== null ? { capacity: view.capacity } : {}),
    ...(view.startsAt !== null ? { startsAt: view.startsAt.toISOString() } : {}),
    ...(view.endsAt !== null ? { endsAt: view.endsAt.toISOString() } : {}),
    claimed: view.claimed,
    sortOrder: view.sortOrder,
    ...(view.mine ? { mine: true } : {}),
  }
}

export interface CleanupDTOExtras {
  slots?: EventSlotDTO[]
  slotCount?: number
  myCapabilities?: readonly HostCapability[]
  coverUrl?: string | null
  galleryUrls?: string[]
  organizationLogoUrl?: string | null
}

export function toOrganizationRef(
  view: CleanupOrganizationView,
  logoUrl: string | null,
): CleanupOrganizationRef {
  return {
    id: view.id,
    slug: view.slug,
    name: view.name,
    logoUrl,
    verified: view.verifiedStatus === "verified",
    verifiedKind: view.verifiedKind,
    donationUrl: view.donationUrl,
  }
}

export function toCleanupDTO(
  record: CleanupRecord,
  joined: boolean,
  linkedReports: LinkedReportRef[] = [],
  myRole: CleanupMemberRole | null = null,
  slotting: CleanupDTOExtras = {},
): CleanupDTO {
  return {
    id: record.id,
    title: record.title,
    type: record.type,
    eventKind: record.eventKind,
    ...(record.description !== null ? { description: record.description } : {}),
    lat: record.lat,
    lng: record.lng,
    scheduledAt: record.scheduledAt.toISOString(),
    status: record.status,
    organizer: toOrganizerPerson(record.organizer),
    going: record.going,
    ...(record.guestCount !== undefined ? { guestCount: record.guestCount } : {}),
    joined,
    ...(myRole !== null ? { myRole } : {}),
    bring: record.bring ?? [],
    address: record.address,
    addressSource: record.addressSource,
    ...(record.dist !== null ? { dist: record.dist } : {}),
    ...(record.jurisdictionGeoid !== null ? { jurisdictionGeoid: record.jurisdictionGeoid } : {}),
    ...(record.referenceCode !== null ? { referenceCode: record.referenceCode } : {}),
    linkedReports,
    slots: slotting.slots ?? [],
    ...(slotting.slotCount !== undefined ? { slotCount: slotting.slotCount } : {}),
    endsAt: record.endsAt === null ? null : record.endsAt.toISOString(),
    timezone: record.timezone,
    visibility: record.visibility,
    coverUrl: slotting.coverUrl ?? null,
    galleryUrls: slotting.galleryUrls ?? [],
    donationUrl: record.donationUrl,
    pageSlug: record.pageSlug,
    registrationOpensAt:
      record.registrationOpensAt === null ? null : record.registrationOpensAt.toISOString(),
    registrationClosesAt:
      record.registrationClosesAt === null ? null : record.registrationClosesAt.toISOString(),
    capacity: record.capacity,
    organization:
      record.organization === null
        ? null
        : toOrganizationRef(record.organization, slotting.organizationLogoUrl ?? null),
    ticketTypes: [],
    myCapabilities: [...(slotting.myCapabilities ?? [])],
    reminderOffsetsMinutes: record.reminderOffsetsMin,
  }
}

export function toLinkedReportRef(
  view: LinkedReportView,
  thumbUrl: string | null,
): LinkedReportRef {
  return {
    id: view.id,
    category: view.category,
    ...(view.type !== undefined ? { type: view.type } : {}),
    title: view.title ?? "Report",
    status: view.status,
    lat: view.lat,
    lng: view.lng,
    ...(view.addr !== null ? { addr: view.addr } : {}),
    ...(thumbUrl !== null ? { thumbUrl } : {}),
    linkedAt: view.linkedAt.toISOString(),
  }
}

export function toLinkedEventRef(view: LinkedEventView): LinkedEventRef {
  return {
    id: view.id,
    title: view.title,
    eventKind: view.eventKind,
    status: view.status,
    scheduledAt: view.scheduledAt.toISOString(),
    endsAt: view.endsAt === null ? null : view.endsAt.toISOString(),
    timezone: view.timezone,
    lat: view.lat,
    lng: view.lng,
    going: view.going,
    organizer: toOrganizerPerson(view.organizer),
    linkedAt: view.linkedAt.toISOString(),
  }
}
