import { avatarGradient } from "@civfix/shared"
import type { CleanupDTO, LinkedEventRef, LinkedReportRef, PersonDTO } from "@civfix/shared"
import type {
  CleanupPersonView,
  CleanupRecord,
  LinkedEventView,
  LinkedReportView,
} from "./cleanup-repository.types.js"

// Default page size for listCleanups when the request omits `limit`. Matches the shared cap of 50.
export const CLEANUPS_DEFAULT_LIMIT = 20

// Max attendee names returned by listAttendees. Cleanups are neighborhood-scale, so a generous flat cap
// (no pagination) is enough for the "who's going" strip; the full `going` count is always returned
// alongside so the client can show "+N others" when the roster exceeds this.
export const ATTENDEES_DEFAULT_LIMIT = 50

// Soft cap on the member ids a thread-unread signal fans out to per cleanup message (listMemberIds). A
// defensive bound so a pathologically large cleanup cannot emit an unbounded set of PUBLISHes per send.
export const THREAD_SIGNAL_MEMBER_CAP = 500

// Backend-side cap on reports linked in one create/reconcile call. The shared schema does not (yet)
// advertise a `.max()`, so the service clamps abusive input before it reaches the per-id-in-one-tx repo
// path (otherwise thousands of ids would pin one connection + open tx). Realistically never hit.
export const MAX_LINKED_REPORTS = 200

// avatarGradient is the shared deterministic helper. It previously had a DIVERGENT local HSL impl here,
// which made the organizer/chat avatar differ from the people-list/profile avatar for the SAME user.
// Converging on the shared brand-palette gradient keeps organizer + profile + chat identical.
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

// isFollowing is false: the cleanups domain does not load the viewer's follow edge for the organizer
// (the detail screen's Follow button reads it from the dedicated social endpoint).
export function toOrganizerPerson(view: CleanupPersonView): PersonDTO {
  return toAttendeePersonDTO(view, false)
}

export function toCleanupDTO(
  record: CleanupRecord,
  joined: boolean,
  linkedReports: LinkedReportRef[] = [],
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
    bring: record.bring ?? [],
    address: record.address,
    ...(record.dist !== null ? { dist: record.dist } : {}),
    linkedReports,
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
