
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

const ROUTABLE_FROM_STATUSES = new Set<AdminReportStatus>(["submitted", "held", "published"])

export function makeAdminReportService(deps: AdminReportServiceDeps): AdminReportService {
  const now = deps.now ?? (() => new Date())
  const presignMedia =
    deps.presignMedia ??
    (async (r2Key: string, thumbKey: string | null) =>
      thumbKey === null ? { url: r2Key } : { url: r2Key, thumbUrl: thumbKey })

  /**
   * D-D1 choke point: mirror a timeline event this service just wrote into the report chat (system
   * message + broadcast + member push). POST-commit, best-effort — the emitter swallows its own errors, so
   * this can never fail (nor roll back) the mutation. No-op when no emitter is injected (offline / fake).
   */
  async function emitTimeline(event: {
    reportId: string
    status: AdminReportStatus
    kind?: ReportTimelineItem["kind"]
    note?: string | null
    body?: string | null
  }): Promise<void> {
    if (deps.reportChatEmitter === undefined) return
    await deps.reportChatEmitter.emit(event)
  }

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
        id: reporter?.id ?? null,
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
        geoid: routing?.geoid ?? null,
        outreach: outreachDTO,
        ...(record.referenceCode !== null ? { referenceCode: record.referenceCode } : {}),
        ...(record.verificationVerdict !== null
          ? { verificationVerdict: record.verificationVerdict }
          : {}),
        ...(record.verifiedAt !== null ? { verifiedAt: record.verifiedAt.toISOString() } : {}),
        ...(record.reporterReportVerified !== null
          ? { reporterReportVerified: record.reporterReportVerified }
          : {}),
      }
    },

    async setStatus(
      id: string,
      input: { status: AdminReportStatus; actorId: string | null },
    ): Promise<void> {
      const note = statusChangeNote(input.status)
      const ok = await deps.repo.setStatus(id, {
        status: input.status,
        note,
        actorId: input.actorId,
      })
      if (!ok) throw AppError.notFound("Report not found")
      // Post-commit: mirror the transition into the report chat (best-effort; never throws).
      await emitTimeline({ reportId: id, status: input.status, kind: timelineKindForStatus(input.status), note })
    },

    async flag(
      id: string,
      input: { reason: string | null; actorId: string | null },
    ): Promise<boolean> {
      const flagged = await deps.repo.toggleFlag(id, input)
      if (flagged === null) throw AppError.notFound("Report not found")
      // The flag toggle writes a timeline row at the report's CURRENT status; reflect it into the chat.
      // We re-read the report so the system message carries the same status the timeline row got. The flag
      // change has ALREADY committed, so this read-back + emit is fully best-effort: a read failure here
      // must NOT reject flag() (that would 500 the admin + a retry double-toggles) — swallow it. (emit is
      // independently best-effort; the try also covers the read that emit itself can't guard.)
      try {
        const record = await deps.repo.getReport(id)
        if (record) {
          await emitTimeline({
            reportId: id,
            status: record.status,
            kind: "status",
            note: flagged ? "Flagged for review" : "Flag cleared",
          })
        }
      } catch {
        /* system-message reflection is best-effort; the flag mutation already committed. */
      }
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
      await emitTimeline({ reportId: id, status: "rejected", kind: timelineKindForStatus("rejected"), note })
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
          throw AppError.validation({ to: "report has no reporter account to notify" })
        }
        await deps.repo.notifyReporter({
          reportId: id,
          reporterUserId: reporterId,
          title: "Update on your report",
          body: input.body,
          link: `/reports/${id}`,
        })
        await recordFollowup(deps, id, {
          note: "Follow-up sent to the reporter",
          actorId: input.actorId,
          to: "reporter",
          destination: reporterId,
        })
        await emitTimeline({
          reportId: id,
          status: record.status,
          kind: "status",
          note: "Follow-up sent to the reporter",
        })
        return { to: "reporter", destination: reporterId }
      }

      const routing = await deps.repo.getRouting(id)
      const contact = routing?.contact ?? null
      if (contact === null || contact === "") {
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
      await recordFollowup(deps, id, {
        note: `Follow-up sent to ${contact}`,
        actorId: input.actorId,
        to: "city",
        destination: contact,
      })
      await emitTimeline({
        reportId: id,
        status: record.status,
        kind: "status",
        note: `Follow-up sent to ${contact}`,
      })
      return { to: "city", destination: contact }
    },

    async routeToJurisdiction(
      id: string,
      input: { contactEmailOverride: string | null; note: string | null; actorId: string | null },
    ): Promise<RouteToJurisdictionResult> {
      const record = await deps.repo.getReport(id)
      if (!record) throw AppError.notFound("Report not found")

      const routing = await deps.repo.getRouting(id)
      const override =
        input.contactEmailOverride && input.contactEmailOverride.trim() !== ""
          ? input.contactEmailOverride.trim()
          : null
      const toAddr = override ?? routing?.contact ?? null
      if (toAddr === null || toAddr === "") {
        throw AppError.notRoutable("No routing contact for this report's jurisdiction")
      }

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
          contentType: m.contentType && m.contentType.trim() !== "" ? m.contentType : "image/jpeg",
          content: bytes,
        })
      }

      // Per-jurisdiction custom forward templates (0050) override the refined default packet when present;
      // they apply on BOTH this manual route AND the auto-forward job (which calls this same method).
      const packet = buildReportPacket(
        record,
        routing,
        mediaLinks,
        input.note,
        routing?.forwardSubjectTemplate ?? null,
        routing?.forwardBodyTemplate ?? null,
      )

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

      const routeNote = `Sent to jurisdiction (${toAddr})`
      // The transition advances the report to `acknowledged` when it was in a routable state; otherwise the
      // route is a non-transition system row at the report's CURRENT status. The chat system message must
      // carry the SAME status the timeline row got.
      const advances = ROUTABLE_FROM_STATUSES.has(record.status)
      await retryOnce(async () => {
        if (advances) {
          await deps.repo.setStatus(id, {
            status: "acknowledged",
            note: routeNote,
            actorId: input.actorId,
          })
        } else {
          await deps.repo.appendSystemTimeline(id, {
            note: routeNote,
            kind: "route",
          })
        }
      })
      await emitTimeline({
        reportId: id,
        status: advances ? "acknowledged" : record.status,
        kind: "route",
        note: routeNote,
      })

      return { threadId: thread.id, routedTo: toAddr }
    },

    async setVerdict(input: {
      id: string
      verdict: "approved" | "rejected"
      actorId: string | null
    }): Promise<void> {
      const ok = await deps.repo.setReportVerdict(input.id, {
        verdict: input.verdict,
        actorId: input.actorId,
      })
      if (!ok) throw AppError.notFound("Report not found")
    },
  }
}

async function recordFollowup(
  deps: AdminReportServiceDeps,
  id: string,
  input: { note: string; actorId: string | null; to: "reporter" | "city"; destination: string },
): Promise<void> {
  await retryOnce(() => deps.repo.appendFollowup(id, input))
}

async function retryOnce(fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
  } catch (err) {
    if (!isRetryableSerializationFailure(err)) throw err
    await fn()
  }
}

function isRetryableSerializationFailure(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code
  return code === "40001" || code === "40P01"
}
