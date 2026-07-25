/**
 * Admin events service (Phase 2): the civfix cleanups domain. Backs the events list, the detail, and the
 * operator actions (set status / log outcome / flag / cancel / post update / link reports), each audited
 * inside the repo transaction with the operator userId the route resolves.
 *
 * STATUS RECONCILIATION (H1): cleanups.status is the Phase-1 enum (upcoming|active|done|cancelled, no
 * CHECK); every read maps stored -> EventStatus and every write maps EventStatus -> stored via
 * event-status.ts, so a filter and a write never disagree and no invalid value is leaked or written.
 *
 * FLAG MODEL: abuse_flags has no `cleanup` subject_type (frozen Phase-1 enum), so an event's "flagged"
 * boolean is tracked via cleanup_timeline rows (kind 'flag'/'unflag'); flagged = the most recent
 * flag/unflag entry is a 'flag'.
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
import { toPersonDTO, type AdminPersonRecord } from "./admin-person.js"
import { mapWithLimit, PRESIGN_CONCURRENCY } from "../media-presign.js"
import {
  eventTimelineKind,
  eventStatusNote,
  resolveEventFilter,
  timelineDefaultNote,
} from "./admin-event-helpers.js"

// The pure helpers historically lived here; re-export them so existing importers (tests, the memory repo)
// keep their import path.
export {
  resolveEventFilter,
  eventStatusNote,
  flaggedFromTimeline,
  eventTimelineKind,
} from "./admin-event-helpers.js"

/**
 * The organizer of a cleanup, as the repo resolves it. Field-identical to a report's reporter, so both read
 * the shared admin-person shape (admin-person.ts, which also owns the SQL columns and both projections);
 * the name is kept because it is what the events domain calls this person.
 */
export type AdminOrganizerRecord = AdminPersonRecord

// A cleanup_timeline row as the repo reads it back. `kind` is the stored free-text kind.
export interface AdminEventTimelineRecord {
  kind: string
  note: string | null
  who: string
  createdAt: Date
}

export interface AdminEventMessageRecord {
  who: string
  text: string
  createdAt: Date
}

export interface AdminEventRecord {
  id: string
  status: EventStatus
  // cleanup vs other_volunteer (0018); only 'cleanup' events may link reports / show the gallery.
  eventKind: EventKind
  // Derived from cleanup_timeline (net flag/unflag toggles).
  flagged: boolean
  title: string
  place: string
  attendees: number
  capacity: number | null
  bags: number
  organizer: AdminOrganizerRecord | null
  desc: string
  address: string
  lat: number
  lng: number
  scheduledAt: Date
}

// `status` is the event status to match (null = any).
export interface ListEventsArgs {
  q: string | null
  status: EventStatus | null
  flaggedOnly: boolean
  cursor: string | null
  limit: number
}

export interface EventMemberRef {
  userId: string
}

export interface AdminEventRepository {
  // Per-facet totals for the filter chips, over the SEARCHED (q) set — accurate + stable across the facet
  // instead of capped to the first keyset page.
  countByBucket(args: { q: string | null }): Promise<AdminEventCounts>
  listEvents(
    args: ListEventsArgs,
  ): Promise<{ records: AdminEventRecord[]; nextCursor: string | null }>
  getEvent(id: string): Promise<AdminEventRecord | null>
  listTimeline(id: string): Promise<AdminEventTimelineRecord[]>
  listMessages(id: string): Promise<AdminEventMessageRecord[]>
  // Returns false when the cleanup does not exist.
  setStatus(
    id: string,
    input: { status: EventStatus; note: string; actorId: string | null },
  ): Promise<boolean>
  // The ONLY write path for cleanups.bags. Returns false when the cleanup is absent.
  setBags(id: string, input: { bags: number; actorId: string | null }): Promise<boolean>
  // Toggle flagged via cleanup_timeline. Returns the resulting state, or null when the cleanup is absent.
  toggleFlag(
    id: string,
    input: { reason: string | null; actorId: string | null },
  ): Promise<boolean | null>
  cancel(id: string, input: { note: string; actorId: string | null }): Promise<boolean>
  // Insert a chat row + a 'message' timeline row + a set-based per-member notification fan-out, ALL in one
  // transaction. Returns the number of members notified, or null when the cleanup does not exist.
  postMessage(
    id: string,
    input: { body: string; actorId: string },
  ): Promise<{ notified: number } | null>
  // The linked-report gallery: only published+public reports, geom decoded + ready-media thumb key.
  loadLinkedReports(id: string): Promise<LinkedReportView[]>
  // Returns the newly-linked ids, or null when the event is missing. Skips non-visible (held/hidden) ids.
  linkReports(
    id: string,
    reportIds: string[],
    actorId: string | null,
  ): Promise<{ linked: string[] } | null>
  // Returns true when a link existed (removed), false when there was none, null when the event is missing.
  unlinkReport(id: string, reportId: string, actorId: string | null): Promise<boolean | null>
}

export interface AdminEventServiceDeps {
  repo: AdminEventRepository
  // Presign a linked report's thumb object key into a client-usable URL. Defaults to an identity
  // pass-through (raw key) when omitted, so offline tests see a thumb without a storage SDK.
  presignThumb?: (thumbKey: string) => Promise<string>
  // Injectable clock so the relative-age labels are deterministic in tests.
  now?: () => Date
}

export interface AdminEventService {
  list(query: AdminEventListQuery): Promise<AdminEventListResponse>
  get(id: string): Promise<AdminEventDTO>
  setStatus(id: string, input: { status: EventStatus; actorId: string | null }): Promise<void>
  setOutcome(id: string, input: { bags: number; actorId: string | null }): Promise<void>
  flag(id: string, input: { reason: string | null; actorId: string | null }): Promise<boolean>
  cancel(id: string, input: { reason: string | null; actorId: string | null }): Promise<void>
  // Returns the number of members notified.
  postMessage(id: string, input: { body: string; actorId: string }): Promise<number>
  // Rejects linking on a non-cleanup eventKind. 404 when the event is missing.
  linkReports(
    id: string,
    reportIds: string[],
    actorId: string | null,
  ): Promise<{ linked: string[] }>
  unlinkReport(id: string, reportId: string, actorId: string | null): Promise<void>
}

export function makeAdminEventService(deps: AdminEventServiceDeps): AdminEventService {
  const now = deps.now ?? (() => new Date())
  const presignThumb = deps.presignThumb ?? ((thumbKey: string) => Promise.resolve(thumbKey))

  function toListItem(record: AdminEventRecord, ref: Date): AdminEventListItemDTO {
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
      // A cleanup always HAS an organizer, so these fallbacks stand in for corrupt data, not for a
      // supported "no organizer" state (the reports surface's anonymous case). Hence `id: ""`, not null:
      // the contract's organizer.id is a plain string.
      organizer: toPersonDTO(record.organizer, ref, { id: "", name: "Unknown", handle: "unknown" }),
      date: toRelAbs(record.scheduledAt, ref),
      coords: [record.lat, record.lng],
    }
  }

  function toTimelineDTO(record: AdminEventTimelineRecord, ref: Date): EventTimelineItem {
    return {
      who: record.who,
      // A note-less row gets a label derived from its own kind, NOT a blanket "Status set to Upcoming"
      // (which would mislead on a join/done/flag row).
      what: record.note ?? timelineDefaultNote(record.kind),
      when: toRelAbs(record.createdAt, ref).rel,
      kind: eventTimelineKind(record.kind),
    }
  }

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
      // switches them — and because they describe the whole set rather than the page, they are computed on
      // PAGE 1 ONLY (the shared admin-list policy; the console reads them off the first page).
      const [{ records, nextCursor }, counts] = await Promise.all([
        deps.repo.listEvents(args),
        args.cursor === null
          ? deps.repo.countByBucket({ q: args.q })
          : Promise.resolve<AdminEventCounts>({
              all: 0,
              upcoming: 0,
              in_progress: 0,
              completed: 0,
              flagged: 0,
            }),
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
      const linkedReports: LinkedReportRef[] = await mapWithLimit(
        linkedViews,
        PRESIGN_CONCURRENCY,
        async (v: LinkedReportView) => {
          const thumbUrl = v.thumbKey !== null ? await presignThumb(v.thumbKey) : null
          return toLinkedReportRef(v, thumbUrl)
        },
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

    async postMessage(id: string, input: { body: string; actorId: string }): Promise<number> {
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
