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
import { toLinkedEventRef, type LinkedEventView } from "../cleanup-service.js"
import { toRelAbs } from "./admin-format.js"
import { toPersonDTO } from "./admin-person.js"
import { mapWithLimit } from "../../lib/concurrency.js"
import { PRESIGN_CONCURRENCY } from "../media-presign.js"
import { isPubliclyVisibleStatus } from "../report-visibility.js"
import { clampLimit } from "./pagination.js"
import { PG_DEADLOCK_DETECTED, PG_SERIALIZATION_FAILURE } from "../../db/pg-errors.js"
import {
  JURISDICTION_REPLY_NOTE,
  resolveListFilter,
  statusChangeNote,
  timelineKindForStatus,
} from "./admin-report-status.js"
import { buildReportPacket, type PacketMediaLink } from "./mail-format.js"
import { pickPreviewMedia, previewThumbnailUrl } from "./admin-report-types.js"
import type {
  AdminReportService,
  AdminReportServiceDeps,
  FollowupResult,
  RouteToJurisdictionResult,
} from "./admin-report-types.js"
import type {
  AdminReportMediaRecord,
  AdminReportRecord,
  AdminReportTimelineRecord,
  ListReportsArgs,
  ReportOutreachState,
} from "./admin-report-repository.js"

export * from "./admin-report-types.js"
export * from "./admin-report-status.js"

const ROUTABLE_FROM_STATUSES: readonly AdminReportStatus[] = ["submitted", "held", "published"]

const ALREADY_ROUTED_CONFLICT = "This report has already been sent to its jurisdiction"

export const SEND_IN_FLIGHT_CONFLICT =
  "A send to this jurisdiction is still in progress. Check back shortly to see the outcome on the outreach trail."

export function isAlreadyRoutedConflict(err: unknown): boolean {
  return (
    err instanceof AppError &&
    err.code === ErrorCode.CONFLICT &&
    err.message === ALREADY_ROUTED_CONFLICT
  )
}

const REPORT_NOT_FOUND = "Report not found"

const REPORTER_FOLLOWUP_NOTE = "Follow-up sent to the reporter"

const ANONYMOUS_REPORTER = { id: null, name: "Anonymous", handle: "anonymous" } as const

const EMPTY_REPORT_COUNTS: AdminReportCounts = {
  all: 0,
  submitted: 0,
  in_progress: 0,
  completed: 0,
  flagged: 0,
  needsVerification: 0,
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
  const presignPacketMedia =
    deps.presignPacketMedia ?? (async (r2Key: string) => (await presignMedia(r2Key, null)).url)

  async function toMediaDTO(m: AdminReportMediaRecord): Promise<ReportMedia> {
    const { url, thumbUrl } = await presignMedia(m.r2Key, m.thumbKey)
    return { id: m.id, kind: m.kind, url, thumbUrl: thumbUrl ?? null }
  }

  async function previewMediaDTO(record: AdminReportRecord): Promise<ReportMedia | null> {
    return record.previewMedia === null ? null : toMediaDTO(record.previewMedia)
  }

  function toListItem(
    record: AdminReportRecord,
    ref: Date,
    preview: ReportMedia | null,
  ): AdminReportListItemDTO {
    return {
      id: record.id,
      category: record.category,
      status: record.status,
      flagged: record.flagged,
      title: record.title,
      place: record.place,
      reporter: toPersonDTO(record.reporter, ref, ANONYMOUS_REPORTER),
      confirmations: record.confirmations,
      submitted: toRelAbs(record.createdAt, ref),
      coords: [record.lat, record.lng],
      address: record.address,
      hasPhoto: record.hasPhoto,
      thumbnailUrl: previewThumbnailUrl(preview),
    }
  }

  function toTimelineDTO(record: AdminReportTimelineRecord, ref: Date): ReportTimelineItem {
    return {
      who: record.who,
      what: record.note ?? statusChangeNote(record.status),
      when: toRelAbs(record.createdAt, ref).rel,
      kind: timelineRecordKind(record),
    }
  }

  return {
    async list(query: AdminReportListQuery): Promise<AdminReportListResponse> {
      const ref = now()
      const { statuses, flaggedOnly, needsVerificationOnly } = resolveListFilter(query.filter)
      const args: ListReportsArgs = {
        q: query.q && query.q.trim() !== "" ? query.q.trim() : null,
        statuses,
        flaggedOnly,
        needsVerificationOnly,
        cursor: query.cursor ?? null,
        limit: clampLimit(query.limit),
      }
      const [{ records, nextCursor }, counts] = await Promise.all([
        deps.repo.listReports(args),
        args.cursor === null
          ? deps.repo.countByBucket({ q: args.q })
          : Promise.resolve<AdminReportCounts>({ ...EMPTY_REPORT_COUNTS }),
      ])
      const items = await mapWithLimit(records, PRESIGN_CONCURRENCY, async (r) =>
        toListItem(r, ref, await previewMediaDTO(r)),
      )
      return { items, nextCursor, counts }
    },

    async get(id: string): Promise<AdminReportDTO> {
      const ref = now()
      const record = await deps.repo.getReport(id)
      if (!record) throw AppError.notFound(REPORT_NOT_FOUND)
      const [timeline, routing, media, linkedEventsMap, outreach] = await Promise.all([
        deps.repo.listTimeline(id),
        deps.repo.getRouting(id),
        deps.repo.listMedia(id),
        deps.loadLinkedEventsForReports !== undefined
          ? deps.loadLinkedEventsForReports([id])
          : Promise.resolve(new Map<string, LinkedEventView[]>()),
        deps.repo.getOutreach(id),
      ])
      const city: ReportRouting = {
        dept: routing?.dept ?? "",
        place: routing?.place ?? record.place,
        contact: routing?.contact ?? null,
        routed: routing?.routed ?? false,
      }
      const mediaDtos: ReportMedia[] = await mapWithLimit(media, PRESIGN_CONCURRENCY, toMediaDTO)
      const base = toListItem(record, ref, pickPreviewMedia(mediaDtos))
      const linkedEvents: LinkedEventRef[] = (linkedEventsMap.get(id) ?? []).map(toLinkedEventRef)
      const outreachDTO: ReportOutreach = {
        status: outreach.status,
        threadId: outreach.threadId,
        routedTo: outreach.routedTo,
        routedAt: outreach.routedAt,
        ...(outreach.sendFailed !== undefined ? { sendFailed: outreach.sendFailed } : {}),
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
      if (!record) throw AppError.notFound(REPORT_NOT_FOUND)
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
          "This report moved on while you were looking at it. Reload and try again.",
        )
      }
      await notifyReporterOfStatus(deps, id, record.reporter?.id ?? null, input.status)
      await emitTimeline(deps, {
        reportId: id,
        status: input.status,
        kind: timelineKindForStatus(input.status),
        note,
      })
    },

    async flag(
      id: string,
      input: { reason: string | null; actorId: string | null },
    ): Promise<boolean> {
      const flagged = await deps.repo.toggleFlag(id, input)
      if (flagged === null) throw AppError.notFound(REPORT_NOT_FOUND)
      // The toggle is committed; failing the request would invite a retry, and a retried toggle unflags.
      try {
        const record = await deps.repo.getReport(id)
        if (record) {
          await emitTimeline(deps, {
            reportId: id,
            status: record.status,
            kind: "status",
            note: flagged ? "Flagged for review" : "Flag cleared",
          })
        }
      } catch (err) {
        deps.logger?.warn({ err, reportId: id }, "report flag chat mirror failed")
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
      if (!ok) throw AppError.notFound(REPORT_NOT_FOUND)
      await emitTimeline(deps, {
        reportId: id,
        status: "rejected",
        kind: timelineKindForStatus("rejected"),
        note,
      })
    },

    async sendFollowup(
      id: string,
      input: { to: "reporter" | "city"; body: string; actorId: string | null },
    ): Promise<FollowupResult> {
      const record = await deps.repo.getReport(id)
      if (!record) throw AppError.notFound(REPORT_NOT_FOUND)

      return input.to === "reporter"
        ? followupToReporter(deps, id, record, input)
        : followupToCity(deps, id, record, input)
    },

    async routeToJurisdiction(
      id: string,
      input: { note: string | null; actorId: string | null },
    ): Promise<RouteToJurisdictionResult> {
      const record = await deps.repo.getReport(id)
      if (!record) throw AppError.notFound(REPORT_NOT_FOUND)

      const routing = await deps.repo.getRouting(id)
      const toAddr = routing?.contact ?? null
      if (toAddr === null || toAddr === "") {
        throw AppError.notRoutable(
          "This report's jurisdiction has no routing contact. Set one in Jurisdictions first.",
        )
      }

      assertRoutable(await deps.repo.getOutreach(id), toAddr)

      const media = await deps.repo.listMedia(id)
      const publiclyVisible =
        isPubliclyVisibleStatus(record.status) && record.visibility === "public"
      const packetMedia: PacketMediaLink[] = []
      for (const m of media) {
        packetMedia.push({ kind: m.kind, url: await presignPacketMedia(m.r2Key, publiclyVisible) })
      }

      const defaults =
        deps.forwardTemplates !== undefined ? await deps.forwardTemplates.get() : null
      const packet = buildReportPacket(record, routing, packetMedia, input.note, {
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
          audit: {
            actorId: input.actorId,
            action: "report.routed",
            target: `report:${id}`,
          },
        })
      })

      const outcome: RouteOutcome = {
        reportId: id,
        note: routeNote,
        actorId: input.actorId,
        statusBefore: record.status,
      }
      await prepared.deliver({ onLateSuccess: () => recordRouteOutcome(deps, outcome) })

      const threadId = prepared.thread.id

      await recordRouteOutcome(deps, outcome)

      return { threadId, routedTo: toAddr }
    },

    async setVerdict(input: {
      id: string
      verdict: "approved" | "rejected"
      actorId: string | null
    }): Promise<void> {
      const note =
        input.verdict === "approved" ? "Approved by an operator" : "Rejected by an operator"
      const ok = await deps.repo.setReportVerdict(input.id, {
        verdict: input.verdict,
        actorId: input.actorId,
        note,
      })
      if (!ok) throw AppError.notFound(REPORT_NOT_FOUND)
      const record = await deps.repo.getReport(input.id)
      await emitTimeline(deps, {
        reportId: input.id,
        status: record?.status ?? "submitted",
        kind: "status",
        note,
      })
    },
  }
}

function timelineRecordKind(record: AdminReportTimelineRecord): ReportTimelineItem["kind"] {
  if ((record.kind ?? null) !== null) return record.kind as ReportTimelineItem["kind"]
  if (record.note?.startsWith(JURISDICTION_REPLY_NOTE) === true) return "reply"
  return timelineKindForStatus(record.status)
}

async function emitTimeline(
  deps: AdminReportServiceDeps,
  event: {
    reportId: string
    status: AdminReportStatus
    kind?: ReportTimelineItem["kind"]
    note?: string | null
    body?: string | null
  },
): Promise<void> {
  if (deps.reportChatEmitter === undefined) return
  await deps.reportChatEmitter.emit(event)
}

interface RouteOutcome {
  reportId: string
  note: string
  actorId: string | null
  statusBefore: AdminReportStatus
}

async function recordRouteOutcome(
  deps: AdminReportServiceDeps,
  outcome: RouteOutcome,
): Promise<void> {
  const { reportId, note, actorId } = outcome
  let advanced = false
  await retryOnce(async () => {
    advanced = await deps.repo.advanceStatusIfIn(reportId, {
      from: ROUTABLE_FROM_STATUSES,
      to: "acknowledged",
      note,
      actorId,
      kind: "route",
    })
    if (!advanced) {
      await deps.repo.appendSystemTimeline(reportId, { note, kind: "route" })
    }
  })
  const current = advanced
    ? "acknowledged"
    : ((await deps.repo.getReport(reportId))?.status ?? outcome.statusBefore)
  await emitTimeline(deps, { reportId, status: current, kind: "route", note })
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
  const retargeted = existing.routedTo !== null && !sameAddress(existing.routedTo, toAddr)
  const bounced = existing.status === "bounced"
  if (existing.packetSent && existing.sendFailed !== true && !retargeted && !bounced) {
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

interface FollowupInput {
  body: string
  actorId: string | null
}

async function followupToReporter(
  deps: AdminReportServiceDeps,
  id: string,
  record: AdminReportRecord,
  input: FollowupInput,
): Promise<FollowupResult> {
  const reporterId = record.reporter?.id
  if (!reporterId || reporterId === "") {
    throw AppError.validation({ to: "report has no reporter account to notify" })
  }
  const notifications = deps.notifications
  if (notifications === undefined) {
    throw AppError.internal("Reporter notifications are not wired on this instance")
  }
  // Audit before the citizen is messaged, so no operator message ever reaches a reporter unrecorded.
  await recordFollowup(deps, id, {
    note: REPORTER_FOLLOWUP_NOTE,
    actorId: input.actorId,
    to: "reporter",
    destination: reporterId,
  })
  await notifications.createNotification(reporterId, {
    type: "report_update",
    title: "Update on your report",
    body: input.body,
    link: `/reports/${id}`,
  })
  await emitTimeline(deps, {
    reportId: id,
    status: record.status,
    kind: "status",
    note: REPORTER_FOLLOWUP_NOTE,
  })
  return { to: "reporter", destination: reporterId }
}

async function followupToCity(
  deps: AdminReportServiceDeps,
  id: string,
  record: AdminReportRecord,
  input: FollowupInput,
): Promise<FollowupResult> {
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
  await emitTimeline(deps, {
    reportId: id,
    status: record.status,
    kind: "status",
    note: `Follow-up sent to ${destination}`,
  })
  return { to: "city", destination }
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
  return code === PG_SERIALIZATION_FAILURE || code === PG_DEADLOCK_DETECTED
}
