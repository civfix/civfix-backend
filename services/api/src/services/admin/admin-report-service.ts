/**
 * Admin reports service (Phase 2): every neighbor report routed to a city department. Backs the reports
 * list (filter/search/paginate), the detail (desc, timeline, reporter, routing, media), and the operator
 * actions: set status, flag/unflag, remove (-> rejected soft-delete), follow-up to the reporter (in-app
 * notification) or the routed city contact (outbound mail), and Approve & send to the jurisdiction.
 *
 * Every read/write goes through AdminReportRepository (the seam), so the service is unit-testable with no
 * DB. Every mutation is audited by the ROUTE (which holds the operator userId); this service performs the
 * effect (timeline + state) and the mail/notification side-effects, returning enough for the route to ack.
 */

import { AppError } from "@civfix/shared"
import type {
  AdminReportDTO,
  AdminReportListItemDTO,
  AdminReportListQuery,
  AdminReportListResponse,
  AdminReportStatus,
  LinkedEventRef,
  ReportMedia,
  ReportOutreach,
  ReportRouting,
  ReportTimelineItem,
} from "@civfix/shared"
import type { OutboundAttachment } from "@civfix/shared/interfaces"
import { toLinkedEventRef, type LinkedEventView } from "../cleanup-service.js"
import { toRelAbs } from "./admin-format.js"
import { mapWithLimit, PRESIGN_CONCURRENCY } from "../media-presign.js"
import {
  JURISDICTION_REPLY_NOTE_PREFIX,
  resolveListFilter,
  statusChangeNote,
  timelineKindForStatus,
} from "./admin-report-status.js"
import {
  attachmentFilename,
  buildReportPacket,
  MAX_PACKET_ATTACHMENTS,
  MAX_PACKET_ATTACHMENT_BYTES,
} from "./mail-format.js"
import type {
  AdminReportRecord,
  AdminReportService,
  AdminReportServiceDeps,
  AdminReportTimelineRecord,
  FollowupResult,
  ListReportsArgs,
  RouteToJurisdictionResult,
} from "./admin-report-types.js"

export * from "./admin-report-types.js"
export * from "./admin-report-status.js"
export {
  buildReportPacket,
  attachmentFilename,
  MAX_PACKET_ATTACHMENTS,
  MAX_PACKET_ATTACHMENT_BYTES,
  type ReportPacket,
} from "./mail-format.js"

/**
 * The report statuses from which Approve & send advances to `acknowledged`. A report already past
 * acknowledged (in_progress/resolved/rejected) keeps its status — re-sending only records a timeline row.
 */
const ROUTABLE_FROM_STATUSES = new Set<AdminReportStatus>(["submitted", "held", "published"])

export function makeAdminReportService(deps: AdminReportServiceDeps): AdminReportService {
  const now = deps.now ?? (() => new Date())
  // Default to an identity pass-through (raw keys) when no presigner is injected, so offline tests still
  // see the seeded key; production wires the real Storage presigner so the photo box renders.
  const presignMedia =
    deps.presignMedia ??
    (async (r2Key: string, thumbKey: string | null) =>
      thumbKey === null ? { url: r2Key } : { url: r2Key, thumbUrl: thumbKey })

  function toListItem(record: AdminReportRecord, ref: Date): AdminReportListItemDTO {
    const reporter = record.reporter
    return {
      id: record.id,
      category: record.category,
      status: record.status,
      flagged: record.flagged,
      title: record.title,
      place: record.place,
      reporter: {
        id: reporter?.id ?? "",
        name: reporter?.name ?? "Anonymous",
        handle: reporter?.handle ?? "anonymous",
        joined: reporter?.joinedAt ? toRelAbs(reporter.joinedAt, ref).abs : "-",
      },
      confirmations: record.confirmations,
      submitted: toRelAbs(record.createdAt, ref),
      coords: [record.lat, record.lng],
      address: record.address,
      hasPhoto: record.hasPhoto,
    }
  }

  function toTimelineDTO(record: AdminReportTimelineRecord, ref: Date): ReportTimelineItem {
    // A jurisdiction-reply row (written at the report's current status by the inbound side-effects) carries
    // the `reply` kind even though report_timeline has no kind column: we recognize it by its note prefix.
    const kind: ReportTimelineItem["kind"] =
      record.note?.startsWith(JURISDICTION_REPLY_NOTE_PREFIX) === true
        ? "reply"
        : timelineKindForStatus(record.status)
    return {
      who: record.who,
      what: record.note ?? statusChangeNote(record.status),
      when: toRelAbs(record.createdAt, ref).rel,
      kind,
    }
  }

  return {
    async list(query: AdminReportListQuery): Promise<AdminReportListResponse> {
      const ref = now()
      const { statuses, flaggedOnly } = resolveListFilter(query.filter)
      const args: ListReportsArgs = {
        q: query.q && query.q.trim() !== "" ? query.q.trim() : null,
        statuses,
        flaggedOnly,
        cursor: query.cursor ?? null,
        limit: query.limit ?? 25,
      }
      // Counts span the SEARCHED set (q) but ignore the status/flagged facet, so the chips stay accurate +
      // stable as the operator switches buckets (replaces the frontend's first-page-only client count).
      const [{ records, nextCursor }, counts] = await Promise.all([
        deps.repo.listReports(args),
        deps.repo.countByBucket({ q: args.q }),
      ])
      return { items: records.map((r) => toListItem(r, ref)), nextCursor, counts }
    },

    async get(id: string): Promise<AdminReportDTO> {
      const ref = now()
      const record = await deps.repo.getReport(id)
      if (!record) throw AppError.notFound("Report not found")
      const [timeline, routing, media, linkedEventsMap, outreach] = await Promise.all([
        deps.repo.listTimeline(id),
        deps.repo.getRouting(id),
        deps.repo.listMedia(id),
        deps.loadLinkedEventsForReports !== undefined
          ? deps.loadLinkedEventsForReports([id])
          : Promise.resolve(new Map<string, LinkedEventView[]>()),
        deps.repo.getOutreach(id),
      ])
      const base = toListItem(record, ref)
      const city: ReportRouting = {
        dept: routing?.dept ?? "",
        place: routing?.place ?? record.place,
        contact: routing?.contact ?? null,
        routed: routing?.routed ?? false,
      }
      // Presign each media object so the admin gets browser-loadable URLs (the repo returns raw r2 keys),
      // bounded so a media-heavy report can't fire dozens of concurrent SigV4 signings.
      const mediaDtos: ReportMedia[] = await mapWithLimit(media, PRESIGN_CONCURRENCY, async (m) => {
        const { url, thumbUrl } = await presignMedia(m.r2Key, m.thumbKey)
        return { id: m.id, kind: m.kind, url, thumbUrl: thumbUrl ?? null }
      })
      const linkedEvents: LinkedEventRef[] = (linkedEventsMap.get(id) ?? []).map(toLinkedEventRef)
      const outreachDTO: ReportOutreach = {
        status: outreach.status,
        threadId: outreach.threadId,
        routedTo: outreach.routedTo,
        routedAt: outreach.routedAt,
      }
      return {
        ...base,
        desc: record.desc,
        timeline: timeline.map((t) => toTimelineDTO(t, ref)),
        city,
        media: mediaDtos,
        linkedEvents,
        // The report's resolved jurisdiction GEOID (deep-links the admin to its Jurisdictions row) + the
        // outreach lifecycle (was it emailed, did the city reply/bounce) + a per-report mail-thread link.
        geoid: routing?.geoid ?? null,
        outreach: outreachDTO,
      }
    },

    async setStatus(
      id: string,
      input: { status: AdminReportStatus; actorId: string | null },
    ): Promise<void> {
      const ok = await deps.repo.setStatus(id, {
        status: input.status,
        note: statusChangeNote(input.status),
        actorId: input.actorId,
      })
      if (!ok) throw AppError.notFound("Report not found")
    },

    async flag(
      id: string,
      input: { reason: string | null; actorId: string | null },
    ): Promise<boolean> {
      const flagged = await deps.repo.toggleFlag(id, input)
      if (flagged === null) throw AppError.notFound("Report not found")
      return flagged
    },

    async remove(
      id: string,
      input: { reason: string | null; actorId: string | null },
    ): Promise<void> {
      const note =
        input.reason && input.reason.trim() !== ""
          ? `Report removed: ${input.reason.trim()}`
          : statusChangeNote("rejected")
      const ok = await deps.repo.remove(id, { note, actorId: input.actorId })
      if (!ok) throw AppError.notFound("Report not found")
    },

    async sendFollowup(
      id: string,
      input: { to: "reporter" | "city"; body: string; actorId: string | null },
    ): Promise<FollowupResult> {
      const record = await deps.repo.getReport(id)
      if (!record) throw AppError.notFound("Report not found")

      if (input.to === "reporter") {
        const reporterId = record.reporter?.id
        if (!reporterId || reporterId === "") {
          // An anonymous report has no account to notify; a clear 422 rather than a silent no-op.
          throw AppError.validation({ to: "report has no reporter account to notify" })
        }
        await deps.repo.notifyReporter({
          reportId: id,
          reporterUserId: reporterId,
          title: "Update on your report",
          body: input.body,
          link: `/reports/${id}`,
        })
        // M4: the notify above is a DB write; appendFollowup writes timeline + audit atomically. Retry once
        // so a transient blip doesn't drop the audit, and never swallow a persistent failure (it surfaces).
        await recordFollowup(deps, id, {
          note: "Follow-up sent to the reporter",
          actorId: input.actorId,
          to: "reporter",
          destination: reporterId,
        })
        return { to: "reporter", destination: reporterId }
      }

      const routing = await deps.repo.getRouting(id)
      const contact = routing?.contact ?? null
      if (contact === null || contact === "") {
        // The design disables City when no contact is on file; enforce it server-side (422, not a bounce).
        throw AppError.validation({ to: "no city contact on file for this report" })
      }
      await deps.outboundMail.sendToCity({
        geoid: routing?.geoid ?? null,
        toAddr: contact,
        subject: `civfix report ${id}`,
        body: input.body,
        reportContext: { reportId: id, category: record.category, place: record.place },
        org: routing?.dept ?? null,
      })
      // M4: SMTP cannot join a DB tx, so the email is already out. Record timeline + audit (atomic) with a
      // one-shot retry so a transient DB blip after a successful send doesn't drop report.followup_sent.
      await recordFollowup(deps, id, {
        note: `Follow-up sent to ${contact}`,
        actorId: input.actorId,
        to: "city",
        destination: contact,
      })
      return { to: "city", destination: contact }
    },

    async routeToJurisdiction(
      id: string,
      input: { contactEmailOverride: string | null; note: string | null; actorId: string | null },
    ): Promise<RouteToJurisdictionResult> {
      const record = await deps.repo.getReport(id)
      if (!record) throw AppError.notFound("Report not found")

      // Resolve the destination: the per-send override (operator-typed) wins, else the routing contact.
      // With neither on file the report is not routable yet (422 NOT_ROUTABLE) — the city has no inbox.
      const routing = await deps.repo.getRouting(id)
      const override =
        input.contactEmailOverride && input.contactEmailOverride.trim() !== ""
          ? input.contactEmailOverride.trim()
          : null
      const toAddr = override ?? routing?.contact ?? null
      if (toAddr === null || toAddr === "") {
        throw AppError.notRoutable("No routing contact for this report's jurisdiction")
      }

      // Presign every asset for the HTML link list, and load IMAGE bytes (skip null/oversize, cap N) for the
      // binary attachments. A missing presigner/loader simply yields fewer attachments (link-only), never an
      // error, so an offline path still routes. Stop loading bytes once the attachment budget is satisfied.
      const media = await deps.repo.listMedia(id)
      const mediaLinks: string[] = []
      const attachments: OutboundAttachment[] = []
      for (const m of media) {
        const { url } = await presignMedia(m.r2Key, m.thumbKey)
        mediaLinks.push(url)
        if (m.kind !== "image" || attachments.length >= MAX_PACKET_ATTACHMENTS) continue
        const bytes = deps.loadMediaBytes ? await deps.loadMediaBytes(m.r2Key) : null
        if (bytes === null || bytes.byteLength > MAX_PACKET_ATTACHMENT_BYTES) continue
        attachments.push({
          filename: attachmentFilename(m.r2Key, attachments.length),
          // Real stored MIME so a WebP/PNG asset isn't mislabeled image/jpeg (won't render); fall back to
          // image/jpeg only when the repo didn't surface a content-type.
          contentType: m.contentType && m.contentType.trim() !== "" ? m.contentType : "image/jpeg",
          content: bytes,
        })
      }

      const packet = buildReportPacket(record, routing, mediaLinks, input.note)

      const { thread } = await deps.outboundMail.sendReportToJurisdiction({
        reportId: id,
        geoid: routing?.geoid ?? null,
        org: routing?.dept ?? null,
        toAddr,
        subject: packet.subject,
        text: packet.text,
        html: packet.html,
        ...(attachments.length > 0 ? { attachments } : {}),
      })

      // Advance toward `acknowledged` — but only from a pre-acknowledged state, so re-routing a report
      // already in_progress/resolved never DOWNGRADES it. Past acknowledged, record the send as a system
      // timeline row (no status change). SMTP already sent here, so retry the DB write once: a transient
      // blip must not leave email-out + report-un-advanced; a persistent failure surfaces (not swallowed).
      await retryOnce(async () => {
        if (ROUTABLE_FROM_STATUSES.has(record.status)) {
          await deps.repo.setStatus(id, {
            status: "acknowledged",
            note: `Sent to jurisdiction (${toAddr})`,
            actorId: input.actorId,
          })
        } else {
          await deps.repo.appendSystemTimeline(id, {
            note: `Sent to jurisdiction (${toAddr})`,
            kind: "route",
          })
        }
      })

      return { threadId: thread.id, routedTo: toAddr }
    },
  }
}

/**
 * Record a follow-up's timeline + audit (atomic in repo.appendFollowup) with a single retry (M4). The
 * external send (mail / in-app notify) has already happened by the time this is called, so a transient DB
 * failure here would otherwise drop report.followup_sent for a real send. One retry absorbs a blip; a
 * persistent failure is rethrown (surfaced, never swallowed) so a sent-but-unrecorded action is loud.
 */
async function recordFollowup(
  deps: AdminReportServiceDeps,
  id: string,
  input: { note: string; actorId: string | null; to: "reporter" | "city"; destination: string },
): Promise<void> {
  await retryOnce(() => deps.repo.appendFollowup(id, input))
}

// One retry for a DB write that follows an already-committed external send (mail/SMTP). A blip is absorbed;
// a persistent failure is rethrown so the sent-but-unrecorded window is loud, not silent.
async function retryOnce(fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
  } catch {
    await fn()
  }
}
