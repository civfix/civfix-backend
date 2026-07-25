import type {
  CleanupMemberRole,
  CleanupStatus,
  CleanupType,
  EventKind,
  ReportCategory,
  ReportStatus,
  ReportType,
} from "@civfix/shared"

// The persisted cleanup row the service projects into a CleanupDTO (geom already decoded to lat/lng).
// `organizer*` are the denormalized organizer person fields the read joins in so the DTO can be built
// without a second round-trip. `going` is the member count; `dist` the optional metres distance for a
// `near` ordering.
export interface CleanupRecord {
  id: string
  organizerUserId: string
  type: CleanupType
  // cleanup vs other_volunteer (0018); only 'cleanup' events may link reports / show the gallery.
  eventKind: EventKind
  title: string
  description: string | null
  lat: number
  lng: number
  scheduledAt: Date
  status: CleanupStatus
  bring: string[] | null
  address: string | null
  // The cleanup's resolved jurisdiction GEOID (#56 / D6), nullable when outside coverage or not yet
  // resolved. Surfaced on the CleanupDTO (additive) + backs the EVENT reference code's JURCODE.
  jurisdictionGeoid: string | null
  // The immutable EVENT reference code minted at create (`EVENT-{JURCODE}-{NNNNNN}`, D1). Nullable forever.
  referenceCode: string | null
  createdAt: Date
  going: number
  dist: number | null
  organizer: CleanupPersonView
}

// A report linked to a cleanup (geom decoded, ready-media thumb resolved, junction linked_at carried).
// Only published+public reports are returned (held/hidden never leak). The service presigns `thumbKey`.
export interface LinkedReportView {
  // The cleanup this link belongs to (so a batched load can regroup by cleanup).
  cleanupId: string
  id: string
  category: ReportCategory
  // Optional fine-grained issue type (0021); when absent the additive LinkedReportRef.type is omitted.
  type?: ReportType
  title: string | null
  status: ReportStatus
  lat: number
  lng: number
  addr: string | null
  // The report's earliest ready-media thumb object key — or, for an image with no thumb yet, its r2 key.
  // Null when the report has no ready asset that can render as a still (a thumbless video is skipped
  // rather than handed over as a raw video key). The service presigns whatever this is.
  thumbKey: string | null
  linkedAt: Date
}

// A cleanup (event) a report is linked to. Carries the organizer person fields + going count + eventKind
// + lifecycle status so the service can build the LinkedEventRef. `reportId` lets a batched load regroup.
export interface LinkedEventView {
  reportId: string
  id: string
  title: string
  eventKind: EventKind
  status: CleanupStatus
  scheduledAt: Date
  lat: number
  lng: number
  going: number
  organizer: CleanupPersonView
  linkedAt: Date
}

// The organizer's person fields as the read projects them (avatar gradient is derived in the service).
export interface CleanupPersonView {
  id: string
  displayName: string
  handle: string | null
  bio: string | null
  // Whether the organizer is document-verified. Optional: a read that does not join user_verification
  // leaves it undefined ⇒ rendered as not verified.
  verified?: boolean
}

// An attendee row: the same person fields as the organizer view plus the viewer's follow relationship
// and the attendee's cleanup_members role (organizer|cohost|member) for the role-aware roster UI.
export interface AttendeeView extends CleanupPersonView {
  isFollowing: boolean
  role: CleanupMemberRole
}

// Arguments for the attendee roster read (the service resolves `onlyFollowed`/`limit` from the viewer).
export interface ListAttendeesArgs {
  cleanupId: string
  viewerId: string | null
  // When true, return only attendees the viewer follows (the "not yet RSVP'd" rule); anonymous ⇒ empty.
  onlyFollowed: boolean
  limit: number
}

// Everything the create transaction needs to persist a cleanup + the organizer membership atomically.
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
  // The cleanup's resolved jurisdiction GEOID (#56 / D6), resolved pre-tx via JurisdictionService; null
  // outside coverage. Stored on cleanups.jurisdiction_geoid.
  jurisdictionGeoid: string | null
  // The resolved jurisdiction's compact integer CODE (jurisdictions.code) — the EVENT reference code's
  // JURCODE segment. UNKNOWN_JURCODE (0) when no jurisdiction resolved (D5). The repo allocates the EVENT
  // code from it as the FIRST write in the create tx (D4).
  jurCode: number
  // Report ids to link in the SAME create tx (filtered to ids that exist; visibility checked by the
  // service). Empty array = no links. Never set for a non-cleanup eventKind.
  linkedReportIds: string[]
}

// A scalar PATCH of an existing cleanup (only the supplied fields change). Geometry via lat+lng pair.
export interface UpdateCleanupPatch {
  title?: string
  description?: string | null
  eventKind?: EventKind
  type?: CleanupType
  scheduledAt?: Date
  // lat+lng MUST be supplied together (the repo rebuilds geom only when both are present).
  lat?: number
  lng?: number
  address?: string | null
  bring?: string[] | null
  // Re-resolved from a moved lat+lng by cleanup-service (the geoid routes the event's municipal
  // resource-request email and buckets its volunteer-hours rollup, so it cannot stay behind when the
  // event moves). ABSENT = leave the stored geoid alone; null = the new position is outside coverage.
  // reference_code's JURCODE segment is never re-minted (immutable public identity, D1).
  jurisdictionGeoid?: string | null
}

// The outcome of a cancel attempt. "already_cancelled" is NOT an error (cancelling twice is a legal
// no-op that still returns the DTO) but it must be distinguishable from a fresh transition, because the
// attendee bell fan-out may only fire once — see cancelCleanupTx / cleanup-service.cancelCleanup.
export type CancelCleanupOutcome = "cancelled" | "already_cancelled" | "not_found"

// A point the caller can sort/measure distance from (for `near` listings).
export interface NearPoint {
  lat: number
  lng: number
}

// A bbox (west/south/east/north) declared structurally to avoid importing the zod type here.
export interface CleanupBBox {
  west: number
  south: number
  east: number
  north: number
}

// Filters for listCleanups, resolved from ListCleanupsRequest by the service.
export interface ListCleanupsFilters {
  when: "upcoming" | "past" | "attending" | undefined
  bbox: CleanupBBox | undefined
  near: NearPoint | undefined
  cursor: string | null
  limit: number
  // The signed-in viewer (or null), used ONLY by `when: "attending"`. Ignored for other `when` values.
  viewerId?: string | null
}

// Persistence seam for the cleanups domain. The production impl runs Drizzle/PostGIS (create +
// organizer-membership insert in ONE transaction); offline tests pass an in-memory impl. Keeping ALL
// cleanup/membership access behind this interface is what makes the service testable with no DB.
export interface CleanupRepository {
  // Insert the cleanup row AND the organizer's cleanup_members(role 'organizer') row in a SINGLE
  // transaction, then read the row back (geom decoded, organizer joined, going counted). This is the
  // atomicity guarantee that membership == chat membership from creation onward.
  createCleanupTx(args: CreateCleanupTxArgs): Promise<CleanupRecord>
  // Apply a scalar PATCH (only the supplied fields change). lat+lng (both present) rebuild geom; supplying
  // neither leaves the position untouched. Returns false when the cleanup does not exist. Does NOT touch
  // links (the service reconciles those separately).
  updateCleanup(id: string, patch: UpdateCleanupPatch): Promise<boolean>
  // Link reports: insert a cleanup_reports row (ON CONFLICT DO NOTHING) + a cleanup_timeline
  // 'report_linked' row per newly-linked id, in one transaction. Returns the ids that were newly linked.
  linkReports(cleanupId: string, reportIds: string[], actorId: string | null): Promise<string[]>
  // Unlink ONE report: delete the cleanup_reports row + append a 'report_unlinked' row, in one
  // transaction. Returns true when a link existed (idempotent no-op otherwise).
  unlinkReport(cleanupId: string, reportId: string, actorId: string | null): Promise<boolean>
  // Reconcile a cleanup's links to EXACTLY `desiredIds`. Returns the applied diff ({ added, removed }).
  reconcileLinkedReports(
    cleanupId: string,
    desiredIds: string[],
    actorId: string | null,
  ): Promise<{ added: string[]; removed: string[] }>
  // Batched load of the reports linked to a set of cleanups, grouped by cleanup id. Only published+public
  // (non-deleted) reports are returned (held/hidden never leak). Empty input ⇒ empty map.
  loadLinkedReportsForCleanups(cleanupIds: string[]): Promise<Map<string, LinkedReportView[]>>
  // Batched load of the events a set of reports is linked to, grouped by report id. Empty input ⇒ empty map.
  loadLinkedEventsForReports(reportIds: string[]): Promise<Map<string, LinkedEventView[]>>
  // Which of the given report ids are visible (published+public, non-deleted)? Used to validate links.
  filterVisibleReportIds(reportIds: string[]): Promise<Set<string>>
  // Load a cleanup by id (decoding geom, joining the organizer + member count). `near` adds the metres
  // distance. Returns null when the id does not exist.
  findCleanupById(id: string, near: NearPoint | null): Promise<CleanupRecord | null>
  // Resolve a cleanup by its immutable reference_code (issue #56 resolve-either getCleanup). Same
  // projection as findCleanupById (no distance). Null when no row carries the code.
  findCleanupByReferenceCode(code: string): Promise<CleanupRecord | null>
  // Page cleanups under the given filters: up to `limit` records + the next cursor (null when exhausted).
  listCleanups(
    filters: ListCleanupsFilters,
  ): Promise<{ records: CleanupRecord[]; nextCursor: string | null }>
  // Whether `userId` is a member of `cleanupId` (any role).
  isMember(cleanupId: string, userId: string): Promise<boolean>
  // `userId`'s cleanup_members role in `cleanupId`, or null when not a member (or the cleanup is
  // missing — callers that must 404 a missing cleanup pair this with organizerOf/findCleanupById).
  // P3: also feeds the chat-powers resolver — organizers AND co-hosts hold pin/delete-others powers
  // in the cleanup room (co-host is organizer-equivalent for chat moderation, per cleanup-service).
  roleOf(cleanupId: string, userId: string): Promise<CleanupMemberRole | null>
  // Batched role probe over a page: of the given cleanup ids, the ones `userId` is a member of, mapped
  // to their role (drives joined + myRole on list DTOs). Empty input ⇒ empty map (no query).
  rolesOf(cleanupIds: string[], userId: string): Promise<Map<string, CleanupMemberRole>>
  // Flip an existing NON-organizer membership row to `role` (promote member→cohost / demote
  // cohost→member). The organizer row is never touched (guarded in SQL as defense-in-depth on top of
  // the service gate). Returns false when no such member row exists (or the target is the organizer).
  setMemberRole(cleanupId: string, userId: string, role: "cohost" | "member"): Promise<boolean>
  // Remove a NON-organizer member row (the same row that gates chat access, so removal drops the chat
  // roster too) and return the fresh member count in the SAME transaction. `removed` is false when no
  // such member row existed (or the target is the organizer — guarded in SQL as defense-in-depth).
  //
  // SECURITY (M17): the same transaction ALSO writes the cleanup_bans row that makes the removal
  // stick. Before this, removal was a bare membership delete against an unconditional self-service
  // join, so the removed user re-joined instantly and in a loop. `actorId` is the removing host,
  // recorded on the ban row. Same-transaction is load-bearing: a ban written afterwards would leave a
  // window in which the target could re-join.
  removeMember(
    cleanupId: string,
    userId: string,
    actorId: string,
  ): Promise<{ removed: boolean; going: number }>
  // Whether `userId` is banned from `cleanupId` (M17). Read by the join path; also lets the service
  // distinguish "not attending" from "removed" when an organizer targets a non-member.
  isBanned(cleanupId: string, userId: string): Promise<boolean>
  // Lift a ban (organizer-only at the service layer). Returns true when a ban row existed; deleting a
  // non-existent ban is an idempotent no-op that returns false.
  unbanMember(cleanupId: string, userId: string): Promise<boolean>
  // The user ids of a cleanup's members, capped at `limit` (a soft fan-out bound). Used by the WS gateway
  // to fan a thread-unread signal to the room's members.
  listMemberIds(cleanupId: string, limit: number): Promise<string[]>
  // Current member count for a cleanup (the "going" number).
  memberCount(cleanupId: string): Promise<number>
  // The organizer's user id, or null when the cleanup does not exist.
  organizerOf(cleanupId: string): Promise<string | null>
  // Upsert a cleanup_members(role 'member') row in a transaction (idempotent: re-joining is a no-op).
  //
  // SECURITY (M17): the ban probe and the membership insert happen in ONE transaction that first takes a
  // FOR SHARE row lock on the cleanups row, and removeMember takes the conflicting FOR NO KEY UPDATE on
  // the same row — so a ban landing concurrently cannot be raced past. (A transaction alone was NOT
  // enough: a plain SELECT on cleanup_bans locks nothing, so a removal could commit between this probe
  // and this insert and leave the target both banned and a member.)
  //
  // Outcomes: "not_found" (no such cleanup — the route 404s), "banned" (a cleanup_bans row exists — the
  // service 403s and NO membership row is written), "joined" (membership present, whether newly inserted
  // or already there).
  joinCleanupTx(cleanupId: string, userId: string): Promise<"joined" | "not_found" | "banned">
  // Delete a cleanup_members row. Returns true when the cleanup exists. Deleting a non-existent membership
  // on an existing cleanup is an idempotent no-op that still returns true.
  leaveCleanup(cleanupId: string, userId: string): Promise<boolean>
  // Cancel a cleanup atomically: UPDATE status='cancelled' + INSERT a 'cancel' cleanup_timeline row.
  // The service composes ALL user-facing copy — the timeline `note` and the notification `body` — and
  // passes them in; the repo only persists (layer separation). `reason` is the raw operator-supplied
  // reason (kept for the fake's observable contract).
  //
  // The outcome distinguishes a FRESH transition from a repeat: this used to return a bare boolean that
  // was true both for "cancelled" and for "was already cancelled", and the caller fanned the attendee
  // bell out unconditionally — so re-cancelling in a loop pushed every attendee's lock screen on every
  // pass. Only "cancelled" writes the timeline row, and only "cancelled" earns a bell.
  //
  // L24: this used to ALSO fan a notifications row out to every member with a raw set-based INSERT,
  // bypassing NotificationService (no prefs, no quiet hours, no locale, no user-channel signal). That
  // fan-out now lives in cleanup-service.cancelCleanup and rides the real pipeline; the transaction is
  // reserved for the two writes that genuinely have to be atomic.
  cancelCleanupTx(
    id: string,
    input: { note: string; body: string; reason: string | null; actorId: string },
  ): Promise<CancelCleanupOutcome>
  // The attendee roster: cleanup_members joined to their (non-deleted) user, with the viewer's
  // `isFollowing` per row. Ordered organizer-first then by join time. `onlyFollowed` restricts the roster.
  listAttendees(args: ListAttendeesArgs): Promise<AttendeeView[]>
  // Resolve a jurisdiction's routing contact by GEOID for an event resource request (#56 / D19), using the
  // SAME precedence reports use: a default (category NULL) jurisdiction_contacts row -> the legacy
  // contact_emails[]. Returns the contact + jurisdiction display name, or null when no usable contact. A
  // null geoid (event outside coverage) yields null.
  resolveJurisdictionContact(geoid: string | null): Promise<{ contact: string; name: string } | null>
  // Append ONE cleanup_timeline row (kind free text, optional note, nullable actor). Used by the event
  // resource-request path (D19) + the inbound city-reply onEventReply (D13) — both write a follow-up entry
  // that lives in the event timeline.
  appendCleanupTimeline(
    cleanupId: string,
    input: { kind: string; note: string | null; actorId: string | null },
  ): Promise<void>
}
