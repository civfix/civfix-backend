/**
 * Admin events service (Phase 2): the civfix cleanups domain.
 *
 * Backs the events list (filter by event status + flagged + search title/place/id/organizer,
 * paginated), the detail (desc, address, timeline, attendee messages, turnout), and the operator
 * actions: set status (writes cleanup_timeline), flag/unflag, cancel (-> cancelled + timeline), and post
 * an update to attendees (-> chat_messages + a notification to each member). See enumeration 2.D +
 * endpoints #22-#27 and reconciliation 4.3 / 4.8.
 *
 * REPOSITORY SEAM: every read/write goes through AdminEventRepository (Drizzle impl in
 * admin-event-repository.drizzle.ts; an in-memory impl in admin-event-repository.memory.ts for the
 * offline unit tests), mirroring the discovery/reports split so the service is testable with no database.
 *
 * STATUS RECONCILIATION (enumeration 4.3): the design's upcoming|in-progress|completed buckets map to
 * the cleanups status upcoming|in_progress|completed, plus `cancelled` ("Cancel event"). cleanups.status
 * is free text in Phase 1 (no CHECK), so the app writes the reconciled values directly.
 *
 * FLAG MODEL: abuse_flags has no `cleanup` subject_type (the frozen Phase 1 enum is
 * report|media|user|anon_token), so an event's "flagged" boolean is tracked via cleanup_timeline rows
 * (kind 'flag' / 'unflag'); flagged = the most recent flag/unflag entry is a 'flag'. The detail timeline
 * projects those rows as the design's 'warn' icon kind.
 *
 * AUDIT: every mutation is audited inside the repo transaction (atomic with the effect), using the
 * operator userId the route resolves from request.auth.userId.
 */

import { AppError } from "@civfix/shared"
import type {
  AdminEventDTO,
  AdminEventListItemDTO,
  AdminEventListQuery,
  AdminEventListResponse,
  EventMessage,
  EventStatus,
  EventTimelineItem,
} from "@civfix/shared"
import { deriveTrust, toRelAbs } from "./admin-format.js"

// ---------------------------------------------------------------------------
// Repository seam (structural records; faked in tests)
// ---------------------------------------------------------------------------

/** The organizer of a cleanup, as the repo resolves it. */
export interface AdminOrganizerRecord {
  id: string
  name: string
  handle: string | null
  emailVerified: boolean
  hasOauth: boolean
  joinedAt: Date | null
}

/** A cleanup_timeline row as the repo reads it back. `kind` is the stored free-text kind. */
export interface AdminEventTimelineRecord {
  kind: string
  note: string | null
  who: string
  createdAt: Date
}

/** A chat_message for the cleanup (the "Message attendees" thread). */
export interface AdminEventMessageRecord {
  who: string
  text: string
  createdAt: Date
}

/**
 * A cleanup row joined with everything the LIST needs: the organizer, the flagged marker (derived from
 * cleanup_timeline), the attendee count (cleanup_members), capacity/bags, date, and coords. The DETAIL
 * adds desc + address + timeline + messages (loaded separately).
 */
export interface AdminEventRecord {
  id: string
  status: EventStatus
  /** Derived from cleanup_timeline (net flag/unflag toggles). */
  flagged: boolean
  title: string
  place: string
  /** Count of cleanup_members (the design's "attendees"). */
  attendees: number
  capacity: number | null
  bags: number
  organizer: AdminOrganizerRecord | null
  desc: string
  address: string
  lat: number
  lng: number
  /** The cleanup's scheduled time (the design's "date"). */
  scheduledAt: Date
}

/** Normalized list arguments the repo consumes. `status` is the event status to match (null = any). */
export interface ListEventsArgs {
  q: string | null
  status: EventStatus | null
  flaggedOnly: boolean
  cursor: string | null
  limit: number
}

/** A member of a cleanup to notify when an operator posts an update. */
export interface EventMemberRef {
  userId: string
}

/**
 * Persistence seam for the admin events domain. The Drizzle impl runs raw SQL (PostGIS for coords); the
 * offline tests pass an in-memory impl.
 */
export interface AdminEventRepository {
  /** Page the events list applying the search / status / flagged facet, newest-first keyset paged. */
  listEvents(
    args: ListEventsArgs,
  ): Promise<{ records: AdminEventRecord[]; nextCursor: string | null }>
  /** Load one cleanup's base record by id, or null when it does not exist. */
  getEvent(id: string): Promise<AdminEventRecord | null>
  /** Load the ordered cleanup_timeline for an event (oldest first). */
  listTimeline(id: string): Promise<AdminEventTimelineRecord[]>
  /** Load the cleanup's chat messages (oldest first), for the message-attendees thread. */
  listMessages(id: string): Promise<AdminEventMessageRecord[]>
  /**
   * Set the cleanup status AND append a cleanup_timeline row noting the transition. Returns false when
   * the cleanup does not exist.
   */
  setStatus(
    id: string,
    input: { status: EventStatus; note: string; actorId: string | null },
  ): Promise<boolean>
  /**
   * Toggle the event's flagged state via cleanup_timeline (append a 'flag' row when not currently
   * flagged, else an 'unflag' row). Returns the resulting flagged state, or null when the cleanup does
   * not exist.
   */
  toggleFlag(
    id: string,
    input: { reason: string | null; actorId: string | null },
  ): Promise<boolean | null>
  /** Cancel the cleanup (status 'cancelled' + a cleanup_timeline 'cancel' row). Returns false when absent. */
  cancel(id: string, input: { note: string; actorId: string | null }): Promise<boolean>
  /**
   * Post an operator update to the cleanup: insert a chat_messages row (from the operator) + a
   * cleanup_timeline 'message' row + a notification row PER member, ALL in one transaction (L4: the
   * fan-out is set-based - INSERT ... SELECT user_id FROM cleanup_members - so it is atomic with the
   * message and is two statements regardless of member count). Returns the number of members notified, or
   * null when the cleanup does not exist.
   */
  postMessage(
    id: string,
    input: { body: string; actorId: string | null },
  ): Promise<{ notified: number } | null>
}

// ---------------------------------------------------------------------------
// Pure helpers (no DB, no IO)
// ---------------------------------------------------------------------------

/**
 * Map the list `filter` facet to a repo query shape. The design facet (all|upcoming|in_progress|
 * completed|flagged) reconciles to: an event status to match and/or the flagged-only marker.
 */
export function resolveEventFilter(filter: string | undefined): {
  status: EventStatus | null
  flaggedOnly: boolean
} {
  switch (filter) {
    case "upcoming":
      return { status: "upcoming", flaggedOnly: false }
    case "in_progress":
      return { status: "in_progress", flaggedOnly: false }
    case "completed":
      return { status: "completed", flaggedOnly: false }
    case "flagged":
      return { status: null, flaggedOnly: true }
    default:
      return { status: null, flaggedOnly: false }
  }
}

/** A short human note for an event status transition (cleanup_timeline note + activity feed). */
export function eventStatusNote(status: EventStatus): string {
  switch (status) {
    case "upcoming":
      return "Status set to Upcoming"
    case "in_progress":
      return "Status set to In progress"
    case "completed":
      return "Status set to Completed"
    case "cancelled":
      return "Event cancelled"
    default:
      return `Status set to ${status}`
  }
}

/**
 * Compute the net flagged state from the ordered flag/unflag timeline kinds: flagged when the LAST
 * flag/unflag entry is a 'flag'. Pure; the repo computes the same in SQL for the list.
 */
export function flaggedFromTimeline(kinds: readonly string[]): boolean {
  let flagged = false
  for (const kind of kinds) {
    if (kind === "flag") flagged = true
    else if (kind === "unflag") flagged = false
  }
  return flagged
}

/**
 * Map a stored cleanup_timeline kind to the design's event-timeline icon kind. The design kinds are
 * create|status|join|message|done|warn|cancel; the stored 'flag'/'unflag' map to 'warn'.
 */
export function eventTimelineKind(stored: string): EventTimelineItem["kind"] {
  switch (stored) {
    case "create":
    case "status":
    case "join":
    case "message":
    case "done":
    case "cancel":
      return stored
    case "flag":
    case "unflag":
    case "warn":
      return "warn"
    default:
      return "status"
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface AdminEventServiceDeps {
  repo: AdminEventRepository
  /** Injectable clock (defaults to () => new Date()) so the relative-age labels are deterministic. */
  now?: () => Date
}

export interface AdminEventService {
  list(query: AdminEventListQuery): Promise<AdminEventListResponse>
  get(id: string): Promise<AdminEventDTO>
  setStatus(id: string, input: { status: EventStatus; actorId: string | null }): Promise<void>
  flag(id: string, input: { reason: string | null; actorId: string | null }): Promise<boolean>
  cancel(id: string, input: { reason: string | null; actorId: string | null }): Promise<void>
  /** Post an update to attendees; returns the number of members notified. */
  postMessage(id: string, input: { body: string; actorId: string | null }): Promise<number>
}

export function makeAdminEventService(deps: AdminEventServiceDeps): AdminEventService {
  const now = deps.now ?? (() => new Date())

  /** Project an event record into the list-row DTO (shared by list + detail base). */
  function toListItem(record: AdminEventRecord, ref: Date): AdminEventListItemDTO {
    const organizer = record.organizer
    return {
      id: record.id,
      status: record.status,
      flagged: record.flagged,
      title: record.title,
      place: record.place,
      attendees: record.attendees,
      capacity: record.capacity,
      bags: record.bags,
      organizer: {
        id: organizer?.id ?? "",
        name: organizer?.name ?? "Unknown",
        handle: organizer?.handle ?? "unknown",
        trust: organizer
          ? deriveTrust({ emailVerified: organizer.emailVerified, hasOauth: organizer.hasOauth })
          : "Unverified",
        joined: organizer?.joinedAt ? toRelAbs(organizer.joinedAt, ref).abs : "-",
      },
      date: toRelAbs(record.scheduledAt, ref),
      coords: [record.lat, record.lng],
    }
  }

  /** Project a cleanup_timeline record into the wire DTO (relative "when" + mapped icon kind). */
  function toTimelineDTO(record: AdminEventTimelineRecord, ref: Date): EventTimelineItem {
    return {
      who: record.who,
      what: record.note ?? eventStatusNote("upcoming"),
      when: toRelAbs(record.createdAt, ref).rel,
      kind: eventTimelineKind(record.kind),
    }
  }

  /** Project a chat message into the wire EventMessage DTO. */
  function toMessageDTO(record: AdminEventMessageRecord, ref: Date): EventMessage {
    return { who: record.who, text: record.text, when: toRelAbs(record.createdAt, ref).rel }
  }

  return {
    async list(query: AdminEventListQuery): Promise<AdminEventListResponse> {
      const ref = now()
      const { status, flaggedOnly } = resolveEventFilter(query.filter)
      const args: ListEventsArgs = {
        q: query.q && query.q.trim() !== "" ? query.q.trim() : null,
        status,
        flaggedOnly,
        cursor: query.cursor ?? null,
        limit: query.limit ?? 25,
      }
      const { records, nextCursor } = await deps.repo.listEvents(args)
      return { items: records.map((r) => toListItem(r, ref)), nextCursor }
    },

    async get(id: string): Promise<AdminEventDTO> {
      const ref = now()
      const record = await deps.repo.getEvent(id)
      if (!record) throw AppError.notFound("Event not found")
      const [timeline, messages] = await Promise.all([
        deps.repo.listTimeline(id),
        deps.repo.listMessages(id),
      ])
      const base = toListItem(record, ref)
      return {
        ...base,
        desc: record.desc,
        address: record.address,
        timeline: timeline.map((t) => toTimelineDTO(t, ref)),
        messages: messages.map((m) => toMessageDTO(m, ref)),
      }
    },

    async setStatus(
      id: string,
      input: { status: EventStatus; actorId: string | null },
    ): Promise<void> {
      const ok = await deps.repo.setStatus(id, {
        status: input.status,
        note: eventStatusNote(input.status),
        actorId: input.actorId,
      })
      if (!ok) throw AppError.notFound("Event not found")
    },

    async flag(
      id: string,
      input: { reason: string | null; actorId: string | null },
    ): Promise<boolean> {
      const flagged = await deps.repo.toggleFlag(id, input)
      if (flagged === null) throw AppError.notFound("Event not found")
      return flagged
    },

    async cancel(
      id: string,
      input: { reason: string | null; actorId: string | null },
    ): Promise<void> {
      const note =
        input.reason && input.reason.trim() !== ""
          ? `Event cancelled: ${input.reason.trim()}`
          : eventStatusNote("cancelled")
      const ok = await deps.repo.cancel(id, { note, actorId: input.actorId })
      if (!ok) throw AppError.notFound("Event not found")
    },

    async postMessage(
      id: string,
      input: { body: string; actorId: string | null },
    ): Promise<number> {
      // L4: the chat message + timeline + the per-member notification fan-out all run in one repo
      // transaction (set-based), so a partial fan-out can no longer happen and the count is exact.
      const result = await deps.repo.postMessage(id, input)
      if (result === null) throw AppError.notFound("Event not found")
      return result.notified
    },
  }
}
