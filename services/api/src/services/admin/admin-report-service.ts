
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

/**
 * The message routeToJurisdiction's duplicate-send gate throws with. Exported because the auto-forward job
 * has to tell THIS conflict ("already delivered, nothing to do") apart from a conflict raised further down
 * the same call — notably a mailer 409 for an unapproved sender, which is a real failure. Both surface as
 * AppError.conflict, so the code alone cannot separate them; matching this exact string can.
 */
export const ALREADY_ROUTED_CONFLICT = "This report has already been sent to its jurisdiction"

/** True when `err` is specifically routeToJurisdiction's duplicate-send refusal (see above). */
export function isAlreadyRoutedConflict(err: unknown): boolean {
  return err instanceof AppError && err.code === ErrorCode.CONFLICT && err.message === ALREADY_ROUTED_CONFLICT
}

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
    return {
      id: record.id,
      category: record.category,
      status: record.status,
      flagged: record.flagged,
      title: record.title,
      place: record.place,
      // A report may genuinely have NO reporter (the anon submit path), which is what the contract's
      // nullable reporter.id encodes — `null` here is a supported state, not missing data.
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
    // Prefer the row's OWN recorded kind (0031) — only setStatus and appendSystemTimeline write it, so most
    // rows arrive here without one and fall through to the reply note-prefix sniff, then the status.
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
      // FACET COUNTS ON PAGE 1 ONLY (the policy every admin list now shares — users/events/reports).
      // The counts describe the whole searched set, so they do not change as the operator scrolls; the
      // console reads them off the first page and the chips are already rendered by the time page 2 is
      // fetched. Recomputing them per page bought nothing and cost a facet aggregate per scroll step.
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
      // M5: the override used to be an ARBITRARY well-formed email address, which made this endpoint a
      // one-request exfiltration channel for the full report packet. It is now constrained to the
      // jurisdiction's own mail domain (see assertOverrideDomainAllowed).
      if (override !== null) assertOverrideDomainAllowed(override, routing?.contact ?? null)
      const toAddr = override ?? routing?.contact ?? null
      if (toAddr === null || toAddr === "") {
        throw AppError.notRoutable("No routing contact for this report's jurisdiction")
      }

      // IDEMPOTENCY, not a one-shot latch. What this endpoint sends is the full citizen packet (identity,
      // exact coordinates, street address, photos), and the send commits in outboundMail BEFORE the status
      // write — so a failure downstream surfaces as a 500 with the packet already emailed, and an
      // operator's natural retry would mail the city a second copy. What must be refused is therefore a
      // repeat of a send that ALREADY REACHED the destination; refusing every non-not_sent state instead
      // strands the report, because there is no other path that re-mails the packet (sendFollowup is
      // text-only to the ON-FILE contact with no attachments, jurisdictions save-and-route only flips the
      // status, and the auto-forward job routes through THIS method):
      //   bounced        -> the contact address is dead; the report never landed. Re-routable.
      //   sendFailed     -> every send attempt threw (a 'failed' mail_event, no 'sent' one). The thread is
      //                     stamped 'sent' before the mailer runs, so this is the only way to see it.
      //   different toAddr -> the operator is correcting the destination (a one-off override, or a
      //                     jurisdiction contact fixed in the directory since). The old address got the
      //                     packet; the right one has not. M5 still constrains an override to the
      //                     jurisdiction's own domain, so this cannot be turned into an exfiltration retry.
      // Everything else (sent / delivered / replied to the SAME address) stays a 409, which is what makes a
      // double-click or a retry-after-500 safe.
      const existing = await deps.repo.getOutreach(id)
      const landed =
        existing.status === "sent" || existing.status === "delivered" || existing.status === "replied"
      const retargeted = existing.routedTo !== null && !sameAddress(existing.routedTo, toAddr)
      if (landed && existing.sendFailed !== true && !retargeted) {
        throw AppError.conflict(ALREADY_ROUTED_CONFLICT)
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
        // Resolve the MIME first: the filename's extension is DERIVED from it, so the two cannot disagree.
        const contentType = attachmentContentType(m.contentType, bytes)
        attachments.push({
          filename: attachmentFilename(m.r2Key, attachments.length, contentType),
          contentType,
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
        // M5: the report.routed audit rides INSIDE the outbound message insert's transaction, so this send
        // cannot commit unaudited. (The route used to write it afterwards, best-effort, catching and
        // downgrading the failure to a warn.) The auto-forward job calls this same method with actorId
        // null, which correctly records a system-originated route.
        audit: {
          actorId: input.actorId,
          action: "report.routed",
          target: `report:${id}`,
          meta: { override: override !== null },
        },
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

/**
 * The MIME type to label a routed packet attachment with.
 *
 * `AdminReportMediaRecord.contentType` exists for this, but nothing in production populates it: `media_assets`
 * stores no MIME column (its `codec` is never written either) and the r2 key carries no extension, so the
 * request's declared contentType is kept only as the stored object's own Content-Type in R2. Intake accepts
 * PNG and WebP as well as JPEG, so the previous flat `image/jpeg` fallback mislabeled those in the city's
 * inbox — some mail clients then refuse to preview the photo the packet exists to deliver.
 *
 * We already hold the bytes (they are the attachment), so the type is SNIFFED from the magic number: correct
 * for exactly the three formats intake allows, with image/jpeg as the last resort for anything else. A repo
 * that does supply a real contentType still wins.
 */
export function attachmentContentType(
  stored: string | null | undefined,
  bytes: Uint8Array,
): string {
  if (stored !== null && stored !== undefined && stored.trim() !== "") return stored
  return sniffImageMime(bytes) ?? "image/jpeg"
}

/** Magic-number MIME sniff for the image formats media intake accepts; null when none matches. */
function sniffImageMime(bytes: Uint8Array): string | null {
  // JPEG: FF D8 FF
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg"
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (bytes.length >= PNG.length && PNG.every((b, i) => bytes[i] === b)) return "image/png"
  // WebP: "RIFF" <4-byte size> "WEBP"
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

/**
 * M5: constrain `contactEmailOverride` on POST /admin/reports/:id/route.
 *
 * What that endpoint sends is a FULL report packet: the reporter's display name, the exact lat/lng, the
 * street address, presigned photo URLs and the raw JPEGs as attachments. Before this check the destination
 * was any address that merely parsed as an email, so a single operator request (or a single phished
 * operator session, since a `X-Client: mobile` bearer call also skips CSRF) exfiltrated a citizen's identity
 * and home location to an attacker-chosen mailbox — with the platform's own DKIM signature on it.
 *
 * The rule: an override may only redirect WITHIN the jurisdiction's own mail domain — the domain of the
 * contact already on file for this report's jurisdiction. That preserves the real workflow the override
 * exists for (the department gave a different mailbox: `streets@` instead of `info@`, `311@` instead of
 * `publicworks@`) while removing the arbitrary-destination capability entirely.
 *
 * Consequence to be aware of when deploying: a jurisdiction with NO contact on file has no known domain, so
 * there is nothing to constrain the override against and it is refused. The operator must first save the
 * routing contact for that jurisdiction ("Save & route" -> discovery.contacts_saved, itself audited
 * in-transaction), then route. That is a deliberate extra step: it moves "where does this citizen's data
 * go" out of a per-send free-text field and into an audited, reviewable jurisdiction record.
 */
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

/**
 * Case-insensitive email compare for "is this the same destination we already mailed?". Mail local-parts
 * are case-sensitive per RFC but no real municipal mailbox distinguishes them, and the console prefills the
 * on-file contact — so a case-only difference must NOT read as a corrected address (which would re-open the
 * duplicate-send window the 409 exists to close).
 */
function sameAddress(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

/** The lowercased domain of an email address, or null when there is not exactly one usable "@" split. */
function emailDomain(email: string | null): string | null {
  if (email === null) return null
  const trimmed = email.trim().toLowerCase()
  const at = trimmed.lastIndexOf("@")
  if (at <= 0 || at === trimmed.length - 1) return null
  const domain = trimmed.slice(at + 1)
  // Reject anything that is not a plain dotted host: an address-literal ("[10.0.0.1]") or a bare label has
  // no meaningful domain to compare, and must not accidentally match.
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
