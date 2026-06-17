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
  AdminEventCounts,
  AdminEventDTO,
  AdminEventListItemDTO,
  AdminEventListQuery,
  AdminEventListResponse,
  EventKind,
  EventMessage,
  EventStatus,
  EventTimelineItem,
  LinkedReportRef,
} from "@civfix/shared"
import { toLinkedReportRef, type LinkedReportView } from "../cleanup-service.js"
import { toRelAbs } from "./admin-format.js"

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
  /** cleanup vs other_volunteer (0018); only 'cleanup' events may link reports / show the gallery. */
  eventKind: EventKind
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
  /**
   * Per-facet event totals for the filter chips, over the SEARCHED (q) set — accurate + stable across the
   * facet instead of capped to the first keyset page.
   */
  countByBucket(args: { q: string | null }): Promise<AdminEventCounts>
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
   * Log a cleanup's outcome: set cleanups.bags (the bags-collected count) + write the event.outcome_logged
   * audit, in one transaction. The ONLY write path for cleanups.bags. Returns false when the cleanup is
   * absent.
   */
  setBags(id: string, input: { bags: number; actorId: string | null }): Promise<boolean>
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
  /**
   * Load the reports linked to an event (its cleanup-coverage gallery), only published+public ones. Reuses
   * the same LinkedReportView the public cleanup read uses (geom decoded + ready-media thumb key).
   */
  loadLinkedReports(id: string): Promise<LinkedReportView[]>
  /**
   * Link reports to an event: cleanup_reports row + 'report_linked' cleanup_timeline row per newly-linked
   * id + an event.reports_linked audit, in one transaction. Returns the newly-linked ids, or null when the
   * event does not exist. Filters out ids that are not visible (published+public) so a held/hidden report
   * cannot be linked.
   */
  linkReports(
    id: string,
    reportIds: string[],
    actorId: string | null,
  ): Promise<{ linked: string[] } | null>
  /**
   * Unlink ONE report from an event: delete the cleanup_reports row + a 'report_unlinked' timeline row + an
   * event.report_unlinked audit, in one transaction. Returns true when a link existed (removed), false when
   * there was none, or null when the event does not exist.
   */
  unlinkReport(id: string, reportId: string, actorId: string | null): Promise<boolean | null>
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
    case "report_linked":
      return "linked"
    case "report_unlinked":
      return "unlinked"
    default:
      return "status"
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface AdminEventServiceDeps {
  repo: AdminEventRepository
  /**
   * Presign a linked report's thumb object key into a client-usable URL (wrapping the Storage seam).
   * OPTIONAL: defaults to an identity pass-through (raw key) when omitted, so offline tests still see a
   * thumb without a storage SDK; production wires the real presigner.
   */
  presignThumb?: (thumbKey: string) => Promise<string>
  /** Injectable clock (defaults to () => new Date()) so the relative-age labels are deterministic. */
  now?: () => Date
}

export interface AdminEventService {
  list(query: AdminEventListQuery): Promise<AdminEventListResponse>
  get(id: string): Promise<AdminEventDTO>
  setStatus(id: string, input: { status: EventStatus; actorId: string | null }): Promise<void>
  /** Log the cleanup's outcome (bags collected) — the only write path for cleanups.bags. */
  setOutcome(id: string, input: { bags: number; actorId: string | null }): Promise<void>
  flag(id: string, input: { reason: string | null; actorId: string | null }): Promise<boolean>
  cancel(id: string, input: { reason: string | null; actorId: string | null }): Promise<void>
  /** Post an update to attendees; returns the number of members notified. */
  postMessage(id: string, input: { body: string; actorId: string | null }): Promise<number>
  /**
   * Link reports to an event (operator action). Rejects linking on a non-cleanup eventKind. Returns the
   * newly-linked ids. 404 when the event is missing.
   */
  linkReports(
    id: string,
    reportIds: string[],
    actorId: string | null,
  ): Promise<{ linked: string[] }>
  /** Unlink ONE report from an event (operator action). 404 when the event is missing. */
  unlinkReport(id: string, reportId: string, actorId: string | null): Promise<void>
}

export function makeAdminEventService(deps: AdminEventServiceDeps): AdminEventService {
  const now = deps.now ?? (() => new Date())
  const presignThumb = deps.presignThumb ?? ((thumbKey: string) => Promise.resolve(thumbKey))

  /** Project an event record into the list-row DTO (shared by list + detail base). */
  function toListItem(record: AdminEventRecord, ref: Date): AdminEventListItemDTO {
    const organizer = record.organizer
    return {
      id: record.id,
      status: record.status,
      eventKind: record.eventKind,
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
      // Counts span the searched set but ignore the facet, so the chips stay accurate as the operator
      // switches them (replaces the frontend's first-page-only client count).
      const [{ records, nextCursor }, counts] = await Promise.all([
        deps.repo.listEvents(args),
        deps.repo.countByBucket({ q: args.q }),
      ])
      return { items: records.map((r) => toListItem(r, ref)), nextCursor, counts }
    },

    async get(id: string): Promise<AdminEventDTO> {
      const ref = now()
      const record = await deps.repo.getEvent(id)
      if (!record) throw AppError.notFound("Event not found")
      const [timeline, messages, linkedViews] = await Promise.all([
        deps.repo.listTimeline(id),
        deps.repo.listMessages(id),
        // Only a 'cleanup' event has a linked-report gallery (cleanup-only linking).
        record.eventKind === "cleanup" ? deps.repo.loadLinkedReports(id) : Promise.resolve([]),
      ])
      const linkedReports: LinkedReportRef[] = await Promise.all(
        linkedViews.map(async (v: LinkedReportView) => {
          const thumbUrl = v.thumbKey !== null ? await presignThumb(v.thumbKey) : null
          return toLinkedReportRef(v, thumbUrl)
        }),
      )
      const base = toListItem(record, ref)
      return {
        ...base,
        desc: record.desc,
        address: record.address,
        timeline: timeline.map((t) => toTimelineDTO(t, ref)),
        messages: messages.map((m) => toMessageDTO(m, ref)),
        linkedReports,
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

    async setOutcome(id: string, input: { bags: number; actorId: string | null }): Promise<void> {
      const ok = await deps.repo.setBags(id, input)
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

    async linkReports(
      id: string,
      reportIds: string[],
      actorId: string | null,
    ): Promise<{ linked: string[] }> {
      // CLEANUP-ONLY LINKING (decision 3): reject linking on a non-cleanup event before any write.
      const record = await deps.repo.getEvent(id)
      if (!record) throw AppError.notFound("Event not found")
      if (record.eventKind !== "cleanup") {
        throw AppError.validation({ reportIds: "only cleanup events can link reports" })
      }
      const result = await deps.repo.linkReports(id, reportIds, actorId)
      if (result === null) throw AppError.notFound("Event not found")
      return result
    },

    async unlinkReport(id: string, reportId: string, actorId: string | null): Promise<void> {
      const result = await deps.repo.unlinkReport(id, reportId, actorId)
      if (result === null) throw AppError.notFound("Event not found")
      // result === false means there was no such link; the unlink is idempotent so that is still a success.
    },
  }
}
