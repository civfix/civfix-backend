import { avatarGradient } from "@civfix/shared"
import type {
  AttendeeDTO,
  CleanupDTO,
  CleanupMemberRole,
  EventSlotDTO,
  LinkedEventRef,
  LinkedReportRef,
  PersonDTO,
} from "@civfix/shared"
import type {
  AttendeeView,
  CleanupPersonView,
  CleanupRecord,
  EventSlotView,
  LinkedEventView,
  LinkedReportView,
} from "./cleanup-repository.types.js"

export const CLEANUPS_DEFAULT_LIMIT = 20

export const ATTENDEES_DEFAULT_LIMIT = 50

export const THREAD_SIGNAL_MEMBER_CAP = 500

export { MAX_LINKED_REPORTS } from "@civfix/shared"

export const LINKED_REPORTS_LIST_PREVIEW = 6

export function toAttendeePersonDTO(view: CleanupPersonView, isFollowing: boolean): PersonDTO {
  return {
    id: view.id,
    name: view.displayName,
    handle: view.handle,
    bio: view.bio,
    avatar: avatarGradient(view.id),
    followers: 0,
    following: 0,
    isFollowing,
    ...(view.verified ? { verified: true } : {}),
  }
}

export function toOrganizerPerson(view: CleanupPersonView): PersonDTO {
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
    claimed: view.claimed,
    sortOrder: view.sortOrder,
    ...(view.mine ? { mine: true } : {}),
  }
}

export function toCleanupDTO(
  record: CleanupRecord,
  joined: boolean,
  linkedReports: LinkedReportRef[] = [],
  myRole: CleanupMemberRole | null = null,
  slotting: { slots?: EventSlotDTO[]; slotCount?: number } = {},
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
    joined,
    ...(myRole !== null ? { myRole } : {}),
    bring: record.bring ?? [],
    address: record.address,
    ...(record.dist !== null ? { dist: record.dist } : {}),
    ...(record.jurisdictionGeoid !== null ? { jurisdictionGeoid: record.jurisdictionGeoid } : {}),
    ...(record.referenceCode !== null ? { referenceCode: record.referenceCode } : {}),
    linkedReports,
    slots: slotting.slots ?? [],
    ...(slotting.slotCount !== undefined ? { slotCount: slotting.slotCount } : {}),
  }
}

export function toLinkedReportRef(view: LinkedReportView, thumbUrl: string | null): LinkedReportRef {
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
    lat: view.lat,
    lng: view.lng,
    going: view.going,
    organizer: toOrganizerPerson(view.organizer),
    linkedAt: view.linkedAt.toISOString(),
  }
}
