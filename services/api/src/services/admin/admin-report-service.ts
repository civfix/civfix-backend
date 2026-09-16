
import { AppError, ErrorCode } from "@civfix/shared"
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
  MAX_PACKET_TOTAL_BYTES,
} from "./mail-format.js"
import { pickPreviewMedia, previewThumbnailUrl } from "./admin-report-types.js"
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

export function makeAdminReportService(deps: AdminReportServiceDeps): AdminReportService {
  const now = deps.now ?? (() => new Date())
  const presignMedia =
    deps.presignMedia ??
    (async (r2Key: string, thumbKey: string | null) =>
      thumbKey === null ? { url: r2Key } : { url: r2Key, thumbUrl: thumbKey })

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

  async function previewMediaDTO(record: AdminReportRecord): Promise<ReportMedia | null> {
    const m = record.previewMedia
    if (m === null) return null
    const { url, thumbUrl } = await presignMedia(m.r2Key, m.thumbKey)
    return { id: m.id, kind: m.kind, url, thumbUrl: thumbUrl ?? null }
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
      thumbnailUrl: previewThumbnailUrl(preview),
    }
  }

  function toTimelineDTO(record: AdminReportTimelineRecord, ref: Date): ReportTimelineItem {
    const kind: ReportTimelineItem["kind"] =
      (record.kind ?? null) !== null
        ? (record.kind as ReportTimelineItem["kind"])
        : record.note?.startsWith(JURISDICTION_REPLY_NOTE_PREFIX) === true
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
      const items = await mapWithLimit(records, PRESIGN_CONCURRENCY, async (r) =>
        toListItem(r, ref, await previewMediaDTO(r)),
      )
      return { items, nextCursor, counts }
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
      const base = toListItem(record, ref, pickPreviewMedia(mediaDtos))
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
      if (override !== null) assertOverrideDomainAllowed(override, routing?.contact ?? null)
      const toAddr = override ?? routing?.contact ?? null
      if (toAddr === null || toAddr === "") {
        throw AppError.notRoutable("No routing contact for this report's jurisdiction")
      }

      assertRoutable(await deps.repo.getOutreach(id), toAddr)

      const media = await deps.repo.listMedia(id)
      const mediaLinks: string[] = []
      const attachments: OutboundAttachment[] = []
      let attachedBytesTotal = 0
      for (const m of media) {
        const { url } = await presignMedia(m.r2Key, m.thumbKey)
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

      const packet = buildReportPacket(
        record,
        routing,
        mediaLinks,
        input.note,
        routing?.forwardSubjectTemplate ?? null,
        routing?.forwardBodyTemplate ?? null,
      )

      const publicRouteAddr = override !== null ? (routing?.contact ?? null) : toAddr
      const routeNote =
        publicRouteAddr !== null && publicRouteAddr !== ""
          ? `Sent to jurisdiction (${publicRouteAddr})`
          : "Sent to jurisdiction"
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
            meta: { override: override !== null },
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

export function assertOverrideDomainAllowed(override: string, knownContact: string | null): void {
  const knownDomain = emailDomain(knownContact)
  if (knownDomain === null) {
    throw AppError.validation(
      { contactEmailOverride: "no_jurisdiction_contact" },
      "This jurisdiction has no routing contact on file, so a one-off destination cannot be verified. " +
        "Save the jurisdiction's routing contact first, then route the report.",
    )
  }
  if (emailDomain(override) !== knownDomain) {
    throw AppError.validation(
      { contactEmailOverride: "domain_not_allowed" },
      `A one-off destination must be on the jurisdiction's own mail domain (@${knownDomain}).`,
    )
  }
}

function sameAddress(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

function assertRoutable(existing: ReportOutreachState, toAddr: string): void {
  if (existing.sendInFlight === true) {
    throw AppError.conflict(SEND_IN_FLIGHT_CONFLICT)
  }
  const landed =
    existing.status === "sent" || existing.status === "delivered" || existing.status === "replied"
  const retargeted = existing.routedTo !== null && !sameAddress(existing.routedTo, toAddr)
  if (landed && existing.sendFailed !== true && !retargeted) {
    throw AppError.conflict(ALREADY_ROUTED_CONFLICT)
  }
}

function emailDomain(email: string | null): string | null {
  if (email === null) return null
  const trimmed = email.trim().toLowerCase()
  const at = trimmed.lastIndexOf("@")
  if (at <= 0 || at === trimmed.length - 1) return null
  const domain = trimmed.slice(at + 1)
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain) ? domain : null
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
