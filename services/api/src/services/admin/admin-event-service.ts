/**
 * Every operator action is audited inside the repo transaction with the operator id the route resolves.
 *
 * abuse_flags has no `cleanup` subject_type, so an event's flagged state lives in cleanup_timeline rows
 * (kind 'flag'/'unflag'): the most recent of them decides.
 */

import { AppError } from "@civfix/shared"
import type {
  AdminEventCounts,
  AdminEventDTO,
  AdminEventListItemDTO,
  AdminEventListQuery,
  AdminEventListResponse,
  EventMessage,
  EventStatus,
  EventTimelineItem,
  LinkedReportRef,
} from "@civfix/shared"
import { toLinkedReportRef, type LinkedReportView } from "../cleanup-service.js"
import { toRelAbs } from "./admin-format.js"
import { toPersonDTO } from "./admin-person.js"
import { mapWithLimit } from "../../lib/concurrency.js"
import { PRESIGN_CONCURRENCY } from "../media-presign.js"
import { clampLimit } from "./pagination.js"
import {
  eventTimelineKind,
  eventStatusNote,
  resolveEventFilter,
  timelineDefaultNote,
} from "./admin-event-helpers.js"
import type {
  AdminEventMessageRecord,
  AdminEventRecord,
  AdminEventRepository,
  AdminEventTimelineRecord,
  ListEventsArgs,
} from "./admin-event-repository.js"

// Re-exported so tests that import the helpers from their old home keep their import path.
export {
  resolveEventFilter,
  eventStatusNote,
  flaggedFromTimeline,
  eventTimelineKind,
} from "./admin-event-helpers.js"

const EVENT_NOT_FOUND = "Event not found"

// A cleanup always HAS an organizer, so this stands in for corrupt data, not for a supported "no organizer"
// state (the reports surface's anonymous case). Hence `id: ""`, not null: the contract's organizer.id is a
// plain string.
const MISSING_ORGANIZER = { id: "", name: "Unknown", handle: "unknown" }

const ZERO_EVENT_COUNTS: AdminEventCounts = {
  all: 0,
  upcoming: 0,
  in_progress: 0,
  completed: 0,
  flagged: 0,
}

export interface EventMemberRef {
  userId: string
}

export interface AdminEventServiceDeps {
  repo: AdminEventRepository
  // Defaults to returning the raw key, so offline tests see a thumb without a storage SDK.
  presignThumb?: (thumbKey: string) => Promise<string>
  now?: () => Date
}

export interface AdminEventService {
  list(query: AdminEventListQuery): Promise<AdminEventListResponse>
  /** An organization's events as admin list rows, for the org detail page (adminListOrgEvents). */
  listForOrganization(
    organizationId: string,
    query: { when: "upcoming" | "past" | "all"; cursor: string | null; limit: number },
  ): Promise<{ items: AdminEventListItemDTO[]; nextCursor: string | null }>
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
      organizer: toPersonDTO(record.organizer, ref, MISSING_ORGANIZER),
      date: toRelAbs(record.scheduledAt, ref),
      coords: [record.lat, record.lng],
    }
  }

  function toTimelineDTO(record: AdminEventTimelineRecord, ref: Date): EventTimelineItem {
    return {
      who: record.who,
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
        limit: clampLimit(query.limit),
      }
      // The counts describe the whole searched set rather than the page, so they are computed on page 1
      // only (the shared admin-list policy; the console reads them off the first page).
      const [{ records, nextCursor }, counts] = await Promise.all([
        deps.repo.listEvents(args),
        args.cursor === null
          ? deps.repo.countByBucket({ q: args.q })
          : Promise.resolve<AdminEventCounts>({ ...ZERO_EVENT_COUNTS }),
      ])
      return { items: records.map((r) => toListItem(r, ref)), nextCursor, counts }
    },

    async listForOrganization(
      organizationId: string,
      query: { when: "upcoming" | "past" | "all"; cursor: string | null; limit: number },
    ): Promise<{ items: AdminEventListItemDTO[]; nextCursor: string | null }> {
      const ref = now()
      const { records, nextCursor } = await deps.repo.listEvents({
        q: null,
        status: null,
        flaggedOnly: false,
        cursor: query.cursor,
        limit: query.limit,
        organizationId,
        ...(query.when === "all" ? {} : { when: { kind: query.when, ref } }),
      })
      return { items: records.map((r) => toListItem(r, ref)), nextCursor }
    },

    async get(id: string): Promise<AdminEventDTO> {
      const ref = now()
      const record = await deps.repo.getEvent(id)
      if (!record) throw AppError.notFound(EVENT_NOT_FOUND)
      const [timeline, messages, linkedViews] = await Promise.all([
        deps.repo.listTimeline(id),
        deps.repo.listMessages(id),
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
      if (input.status !== "cancelled") {
        throw AppError.conflict(
          "Event status is derived from its schedule and can't be set by hand.",
        )
      }
      const ok = await deps.repo.cancel(id, {
        note: eventStatusNote("cancelled"),
        actorId: input.actorId,
      })
      if (!ok) throw AppError.notFound(EVENT_NOT_FOUND)
    },

    async setOutcome(id: string, input: { bags: number; actorId: string | null }): Promise<void> {
      const ok = await deps.repo.setBags(id, input)
      if (!ok) throw AppError.notFound(EVENT_NOT_FOUND)
    },

    async flag(
      id: string,
      input: { reason: string | null; actorId: string | null },
    ): Promise<boolean> {
      const flagged = await deps.repo.toggleFlag(id, input)
      if (flagged === null) throw AppError.notFound(EVENT_NOT_FOUND)
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
      if (!ok) throw AppError.notFound(EVENT_NOT_FOUND)
    },

    async postMessage(id: string, input: { body: string; actorId: string }): Promise<number> {
      const result = await deps.repo.postMessage(id, input)
      if (result === null) throw AppError.notFound(EVENT_NOT_FOUND)
      return result.notified
    },

    async linkReports(
      id: string,
      reportIds: string[],
      actorId: string | null,
    ): Promise<{ linked: string[] }> {
      // Rejected before any write, so a non-cleanup event never gains a link.
      const record = await deps.repo.getEvent(id)
      if (!record) throw AppError.notFound(EVENT_NOT_FOUND)
      if (record.eventKind !== "cleanup") {
        throw AppError.validation({ reportIds: "only cleanup events can link reports" })
      }
      const result = await deps.repo.linkReports(id, reportIds, actorId)
      if (result === null) throw AppError.notFound(EVENT_NOT_FOUND)
      return result
    },

    async unlinkReport(id: string, reportId: string, actorId: string | null): Promise<void> {
      const result = await deps.repo.unlinkReport(id, reportId, actorId)
      if (result === null) throw AppError.notFound(EVENT_NOT_FOUND)
      // result === false means there was no such link; the unlink is idempotent so that is still a success.
    },
  }
}
