import type { AdminEventCounts, EventKind, EventStatus } from "@civfix/shared"
import type { LinkedReportView } from "../cleanup-service.js"
import type { AdminPersonRecord } from "./admin-person.js"

/** Field-identical to a report's reporter; the alias keeps the events domain's name for this person. */
export type AdminOrganizerRecord = AdminPersonRecord

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
  // Only 'cleanup' events may link reports or show the linked-report gallery.
  eventKind: EventKind
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

// A null `status` matches any status.
export interface ListEventsArgs {
  q: string | null
  status: EventStatus | null
  flaggedOnly: boolean
  cursor: string | null
  limit: number
  /** Restrict to events linked to this organization (adminListOrgEvents). */
  organizationId?: string
  /** Time facet relative to `ref`: upcoming = scheduled_at >= ref, past = scheduled_at < ref. */
  when?: { kind: "upcoming" | "past"; ref: Date }
}

export interface AdminEventRepository {
  // Totals over the whole searched set rather than the first keyset page, so the filter chips stay
  // accurate as the operator switches facets.
  countByBucket(args: { q: string | null }): Promise<AdminEventCounts>
  listEvents(
    args: ListEventsArgs,
  ): Promise<{ records: AdminEventRecord[]; nextCursor: string | null }>
  getEvent(id: string): Promise<AdminEventRecord | null>
  listTimeline(id: string): Promise<AdminEventTimelineRecord[]>
  listMessages(id: string): Promise<AdminEventMessageRecord[]>
  // The only write path for cleanups.bags. Returns false when the cleanup is absent.
  setBags(id: string, input: { bags: number; actorId: string | null }): Promise<boolean>
  // Returns the resulting flagged state, or null when the cleanup is absent.
  toggleFlag(
    id: string,
    input: { reason: string | null; actorId: string | null },
  ): Promise<boolean | null>
  cancel(id: string, input: { note: string; actorId: string | null }): Promise<boolean>
  // The chat row, the 'message' timeline row and the per-member notification fan-out commit in one
  // transaction. Returns the number of members notified, or null when the cleanup does not exist.
  postMessage(
    id: string,
    input: { body: string; actorId: string },
  ): Promise<{ notified: number } | null>
  // Only publicly visible reports appear in the gallery.
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
