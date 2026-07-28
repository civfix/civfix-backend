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

// Default page size for listCleanups when the request omits `limit`. Matches the shared cap of 50.
export const CLEANUPS_DEFAULT_LIMIT = 20

// Max attendee names returned by listAttendees. Cleanups are neighborhood-scale, so a generous flat cap
// (no pagination) is enough for the "who's going" strip; the full `going` count is always returned
// alongside so the client can show "+N others" when the roster exceeds this.
export const ATTENDEES_DEFAULT_LIMIT = 50

// Soft cap on the member ids a thread-unread signal fans out to per cleanup message (listMemberIds). A
// defensive bound so a pathologically large cleanup cannot emit an unbounded set of PUBLISHes per send.
export const THREAD_SIGNAL_MEMBER_CAP = 500

// Cap on reports linked in one create/reconcile call, RE-EXPORTED from the contract rather than
// re-declared here (L23). CreateCleanupRequestSchema/UpdateCleanupRequestSchema now carry
// `.max(MAX_LINKED_REPORTS)` themselves, so the service's clamp and the wire schema are the same number
// by construction; a second local literal is exactly the drift this re-export exists to prevent.
export { MAX_LINKED_REPORTS } from "@civfix/shared"

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

// An attendees-roster row: the PersonDTO plus the attendee's cleanup_members role (WS4 — drives the
// co-host badge + the permission-aware kebab in the roster UI) and, P9/B29b, the signup slot they
// claimed. `slot` is emitted whenever the read resolved it (including as an explicit null, which means
// "RSVP'd without a slot") and omitted entirely when the read did not join the claims table — that is
// the difference between "no slot" and "this server didn't look", and the client renders both as none.
export function toAttendeeDTO(view: AttendeeView, isFollowing: boolean): AttendeeDTO {
  return {
    ...toAttendeePersonDTO(view, isFollowing),
    role: view.role,
    ...(view.slot !== undefined ? { slot: view.slot } : {}),
  }
}

// One slot row of the event's signup board. `claimed` is passed through UNCLAMPED on purpose: lowering
// a capacity below the current claim count is legal and evicts nobody (B25), so the UI renders "6/4"
// honestly rather than pretending the slot is exactly full.
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
  // The VIEWER's membership role (WS4): null/omitted when the viewer is not a member (incl. anonymous)
  // or when a call site has no viewer context (the DTO field is optional in the shared contract).
  myRole: CleanupMemberRole | null = null,
  // P9 (B29a). `slots` is the FULL board and is populated on the DETAIL-shaped responses only
  // (getCleanup / create / update / complete / claim). A list read leaves it empty and passes
  // `slotCount` instead, so an empty `slots` is never ambiguous between "no slots" and "not hydrated".
  // An options object rather than two more positional parameters: this function already takes four.
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
    // Additive #56 fields (D6): the event's resolved jurisdiction + its immutable reference code. Both
    // omitted when null so a consumer built against the prior contract still parses.
    ...(record.jurisdictionGeoid !== null ? { jurisdictionGeoid: record.jurisdictionGeoid } : {}),
    ...(record.referenceCode !== null ? { referenceCode: record.referenceCode } : {}),
    linkedReports,
    // CleanupDTOSchema.slots is a `.default([])` field, so `slots` is REQUIRED on the inferred output
    // type and this explicitly-annotated `: CleanupDTO` literal — the sole construction point for every
    // call site — must supply it, exactly like `linkedReports` above. A caller that hydrates passes the
    // board; every other caller keeps the empty default.
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
