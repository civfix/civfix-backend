
import {
  ADMIN_REPORT_STATUS_LABELS,
  AppError,
  canTransitionReportStatus,
  ErrorCode,
} from "@civfix/shared"
import type {
  AdminReportCounts,
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
import { toPersonDTO } from "./admin-person.js"
import { mapWithLimit, PRESIGN_CONCURRENCY } from "../media-presign.js"
import {
  JURISDICTION_REPLY_NOTE,
  resolveListFilter,
  statusChangeNote,
  timelineKindForStatus,
} from "./admin-report-status.js"
import {
  attachmentFilename,
  buildReportPacket,
  MAX_PACKET_ATTACHMENTS,
  MAX_PACKET_ATTACHMENT_BYTES,
  MAX_PACKET_TOTAL_BYTES,
} from "./mail-format.js"
import type {
  AdminReportRecord,
  AdminReportService,
  AdminReportServiceDeps,
  AdminReportTimelineRecord,
  FollowupResult,
  ListReportsArgs,
  ReportOutreachState,
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

const ROUTABLE_FROM_STATUSES: readonly AdminReportStatus[] = ["submitted", "held", "published"]

export const ALREADY_ROUTED_CONFLICT = "This report has already been sent to its jurisdiction"

export const SEND_IN_FLIGHT_CONFLICT =
  "A send to this jurisdiction is still in progress. Check back shortly — the outcome will appear on the outreach trail."

export function isAlreadyRoutedConflict(err: unknown): boolean {
  return err instanceof AppError && err.code === ErrorCode.CONFLICT && err.message === ALREADY_ROUTED_CONFLICT
}

function firstTemplate(...candidates: (string | null | undefined)[]): string | null {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim() !== "") return candidate
  }
  return null
}

export function makeAdminReportService(deps: AdminReportServiceDeps): AdminReportService {
  const now = deps.now ?? (() => new Date())
  const presignMedia =
    deps.presignMedia ??
    (async (r2Key: string, thumbKey: string | null) =>
      thumbKey === null ? { url: r2Key } : { url: r2Key, thumbUrl: thumbKey })
  const presignPacketMedia = deps.presignPacketMedia ?? presignMedia

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
    return {
      id: record.id,
      category: record.category,
      status: record.status,
      flagged: record.flagged,
      title: record.title,
      place: record.place,
      reporter: toPersonDTO(record.reporter, ref, {
        id: null,
        name: "Anonymous",
        handle: "anonymous",
      }),
      confirmations: record.confirmations,
      submitted: toRelAbs(record.createdAt, ref),
      coords: [record.lat, record.lng],
      address: record.address,
      hasPhoto: record.hasPhoto,
    }
  }

  function toTimelineDTO(record: AdminReportTimelineRecord, ref: Date): ReportTimelineItem {
    const kind: ReportTimelineItem["kind"] =
      (record.kind ?? null) !== null
        ? (record.kind as ReportTimelineItem["kind"])
        : record.note?.startsWith(JURISDICTION_REPLY_NOTE) === true
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
        args.cursor === null
          ? deps.repo.countByBucket({ q: args.q })
          : Promise.resolve<AdminReportCounts>({
              all: 0,
              submitted: 0,
              in_progress: 0,
              completed: 0,
              flagged: 0,
            }),
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
      const record = await deps.repo.getReport(id)
      if (!record) throw AppError.notFound("Report not found")
      if (input.status === "rejected") {
        throw AppError.validation({ status: "use_remove" }, "Use Remove to reject a report")
      }
      if (record.status === input.status) return
      if (!canTransitionReportStatus(record.status, input.status)) {
        throw AppError.validation(
          { status: "illegal_transition" },
          `Cannot move a report from ${ADMIN_REPORT_STATUS_LABELS[record.status]} to ` +
            `${ADMIN_REPORT_STATUS_LABELS[input.status]}`,
        )
      }
      const note = statusChangeNote(input.status)
      const advanced = await deps.repo.advanceStatusIfIn(id, {
        from: [record.status],
        to: input.status,
        note,
        actorId: input.actorId,
        kind: timelineKindForStatus(input.status),
      })
      if (!advanced) {
        const current = await deps.repo.getReport(id)
        if (current?.status === input.status) return
        throw AppError.conflict(
          "This report moved on while you were looking at it — reload and try again",
        )
      }
      await notifyReporterOfStatus(deps, id, record.reporter?.id ?? null, input.status)
      await emitTimeline({ reportId: id, status: input.status, kind: timelineKindForStatus(input.status), note })
    },

    async flag(
      id: string,
      input: { reason: string | null; actorId: string | null },
    ): Promise<boolean> {
      const flagged = await deps.repo.toggleFlag(id, input)
      if (flagged === null) throw AppError.notFound("Report not found")
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
        void 0
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
        const notifications = deps.notifications
        if (notifications === undefined) {
          throw AppError.internal("Reporter notifications are not wired on this instance")
        }
        await notifications.createNotification(reporterId, {
          type: "report_update",
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
      const outreach = await deps.repo.getOutreach(id)
      assertNoSendInFlight(outreach)
      if (outreach.threadId === null) {
        throw AppError.validation(
          { to: "not_routed" },
          "Send the report to the jurisdiction first; follow-ups go on that conversation",
        )
      }
      const destination = outreach.routedTo ?? routing?.contact ?? null
      if (destination === null || destination === "") {
        throw AppError.validation({ to: "no city contact on file for this report" })
      }
      await deps.outboundMail.appendOutbound(outreach.threadId, {
        body: input.body,
        toAddr: destination,
        audit: {
          actorId: input.actorId,
          action: "mail.replied",
          meta: { reportId: id, to: destination },
        },
      })
      await recordFollowup(deps, id, {
        note: `Follow-up sent to ${destination}`,
        actorId: input.actorId,
        to: "city",
        destination,
      })
      await emitTimeline({
        reportId: id,
        status: record.status,
        kind: "status",
        note: `Follow-up sent to ${destination}`,
      })
      return { to: "city", destination }
    },

    async routeToJurisdiction(
      id: string,
      input: { note: string | null; actorId: string | null },
    ): Promise<RouteToJurisdictionResult> {
      const record = await deps.repo.getReport(id)
      if (!record) throw AppError.notFound("Report not found")

      const routing = await deps.repo.getRouting(id)
      const toAddr = routing?.contact ?? null
      if (toAddr === null || toAddr === "") {
        throw AppError.notRoutable(
          "No routing contact for this report's jurisdiction — set one in Jurisdictions first",
        )
      }

      assertRoutable(await deps.repo.getOutreach(id), toAddr)

      const media = await deps.repo.listMedia(id)
      const mediaLinks: string[] = []
      const attachments: OutboundAttachment[] = []
      let attachedBytesTotal = 0
      for (const m of media) {
        const { url } = await presignPacketMedia(m.r2Key, m.thumbKey)
        mediaLinks.push(url)
        if (m.kind !== "image" || attachments.length >= MAX_PACKET_ATTACHMENTS) continue
        const bytes = deps.loadMediaBytes ? await deps.loadMediaBytes(m.r2Key) : null
        if (bytes === null || bytes.byteLength > MAX_PACKET_ATTACHMENT_BYTES) continue
        if (attachedBytesTotal + bytes.byteLength > MAX_PACKET_TOTAL_BYTES) continue
        attachedBytesTotal += bytes.byteLength
        const contentType = attachmentContentType(m.contentType, bytes)
        attachments.push({
          filename: attachmentFilename(m.r2Key, attachments.length, contentType),
          contentType,
          content: bytes,
        })
      }

      const defaults =
        deps.forwardTemplates !== undefined ? await deps.forwardTemplates.get() : null
      const packet = buildReportPacket(record, routing, mediaLinks, input.note, {
        subject: firstTemplate(routing?.forwardSubjectTemplate, defaults?.subjectTemplate),
        body: firstTemplate(routing?.forwardBodyTemplate, defaults?.bodyTemplate),
      })

      const routeNote = `Sent to jurisdiction (${toAddr})`
      const prepared = await deps.repo.withRouteLock(id, async () => {
        assertRoutable(await deps.repo.getOutreach(id), toAddr)
        return deps.outboundMail.prepareReportToJurisdiction({
          reportId: id,
          geoid: routing?.geoid ?? null,
          org: routing?.dept ?? null,
          toAddr,
          subject: packet.subject,
          text: packet.text,
          html: packet.html,
          ...(attachments.length > 0 ? { attachments } : {}),
          audit: {
            actorId: input.actorId,
            action: "report.routed",
            target: `report:${id}`,
          },
        })
      })

      const recordRouteOutcome = async (): Promise<void> => {
        let advanced = false
        await retryOnce(async () => {
          advanced = await deps.repo.advanceStatusIfIn(id, {
            from: ROUTABLE_FROM_STATUSES,
            to: "acknowledged",
            note: routeNote,
            actorId: input.actorId,
            kind: "route",
          })
          if (!advanced) {
            await deps.repo.appendSystemTimeline(id, { note: routeNote, kind: "route" })
          }
        })
        const current = advanced ? "acknowledged" : ((await deps.repo.getReport(id))?.status ?? record.status)
        await emitTimeline({ reportId: id, status: current, kind: "route", note: routeNote })
      }

      await prepared.deliver({ onLateSuccess: recordRouteOutcome })

      const threadId = prepared.thread.id

      await recordRouteOutcome()

      return { threadId, routedTo: toAddr }
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
      const note =
        input.verdict === "approved" ? "Approved by an operator" : "Rejected by an operator"
      await deps.repo.appendSystemTimeline(input.id, { note, kind: "status" })
      const record = await deps.repo.getReport(input.id)
      await emitTimeline({
        reportId: input.id,
        status: record?.status ?? "submitted",
        kind: "status",
        note,
      })
    },
  }
}

export function attachmentContentType(
  stored: string | null | undefined,
  bytes: Uint8Array,
): string {
  if (stored !== null && stored !== undefined && stored.trim() !== "") return stored
  return sniffImageMime(bytes) ?? "image/jpeg"
}

function sniffImageMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg"
  }
  const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (bytes.length >= PNG.length && PNG.every((b, i) => bytes[i] === b)) return "image/png"
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp"
  }
  return null
}

function sameAddress(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

function assertNoSendInFlight(existing: ReportOutreachState): void {
  if (existing.sendInFlight === true) {
    throw AppError.conflict(SEND_IN_FLIGHT_CONFLICT)
  }
}

function assertRoutable(existing: ReportOutreachState, toAddr: string): void {
  assertNoSendInFlight(existing)
  const landed =
    existing.status === "sent" || existing.status === "delivered" || existing.status === "replied"
  const retargeted = existing.routedTo !== null && !sameAddress(existing.routedTo, toAddr)
  if (landed && existing.sendFailed !== true && !retargeted) {
    throw AppError.conflict(ALREADY_ROUTED_CONFLICT)
  }
}

const STATUS_NOTIFICATION_BODIES: Partial<Record<AdminReportStatus, string>> = {
  in_progress: "The city is working on your report.",
  resolved: "Your report has been marked resolved.",
}

async function notifyReporterOfStatus(
  deps: AdminReportServiceDeps,
  reportId: string,
  reporterUserId: string | null,
  status: AdminReportStatus,
): Promise<void> {
  const body = STATUS_NOTIFICATION_BODIES[status]
  if (body === undefined) return
  if (reporterUserId === null || reporterUserId === "") return
  const notifications = deps.notifications
  if (notifications === undefined) {
    deps.logger?.warn(
      { reportId, status },
      "report status changed with no notifier wired: the reporter was not told",
    )
    return
  }
  try {
    await notifications.createNotification(reporterUserId, {
      type: "report_update",
      title: `Your report is ${ADMIN_REPORT_STATUS_LABELS[status].toLowerCase()}`,
      body,
      link: `/reports/${reportId}`,
    })
  } catch (err) {
    deps.logger?.warn(
      { err, reportId, status },
      "report_update notification failed (suppressed: the status change is committed)",
    )
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
