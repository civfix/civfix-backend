import type { JobHandler, JobHandlerArg, Storage } from "@civfix/seams"
import { assertRoutable, firstTemplate } from "../admin/admin-report-service.js"
import type {
  AdminReportRecord,
  AdminReportRepository,
  AdminReportRoutingRecord,
} from "../admin/admin-report-repository.js"
import type { ForwardTemplateReader } from "../admin/forward-template-repository.js"
import { buildReportPacket, type PacketMediaLink } from "../admin/mail-format.js"
import type { MailRepository } from "../admin/mail-repository.js"
import {
  isOutboundSendDeadlineError,
  type DeliverOptions,
  type OutboundMailService,
} from "../admin/outbound-mail-service.js"
import { isFinalJobAttempt } from "../job-attempt.js"
import type { PresignPacketMedia } from "../media-presign.js"
import { isPubliclyVisibleStatus } from "../report-visibility.js"
import { pickFilingAttachments, type FilingEmailContent } from "./filing-attachments.js"
import type { FilingRepository } from "./filing-repository.js"
import { isFileable, type FilingService } from "./filing-service.js"
import { ticketTextClosing } from "./filing-ticket-text.js"
import {
  FILING_REASON_DETAIL_MAX,
  type FilingMutableFields,
  type FilingRecord,
} from "./filing-types.js"
import type { FilingEmailJobData } from "./filings-worker.js"

export interface FilingEmailLogger {
  warn(obj: unknown, msg?: string): void
}

export interface FilingEmailDeps {
  filings: Pick<FilingRepository, "getById" | "getSettings" | "claim" | "transition">
  reports: Pick<
    AdminReportRepository,
    "getReport" | "getRouting" | "listMedia" | "getOutreach" | "withRouteLock"
  >
  mail: Pick<MailRepository, "latestUnsentPacketId">
  outboundMail: Pick<OutboundMailService, "prepareReportToJurisdiction" | "redeliverReportPacket">
  storage: Pick<Storage, "getObject">
  presignPacketMedia: PresignPacketMedia
  forwardTemplates?: ForwardTemplateReader
  filingService: Pick<FilingService, "applyFilingSuccess">
  logger: FilingEmailLogger
}

interface Recipient {
  routing: AdminReportRoutingRecord
  toAddr: string
}

/** What the claimed try does once the route lock is released. */
type Step =
  | { kind: "stale" }
  | { kind: "moved" }
  | { kind: "no_route" }
  | { kind: "delivered"; threadId: string }
  | {
      kind: "send"
      threadId: string
      deliver: (opts: DeliverOptions) => Promise<unknown>
    }
  | { kind: "failed"; err: unknown }

function filingIdOf(data: unknown): string | null {
  if (data !== null && typeof data === "object") {
    const value = (data as Partial<FilingEmailJobData>).filingId
    if (typeof value === "string" && value.length > 0) return value
  }
  return null
}

function recipientOf(routing: AdminReportRoutingRecord | null): Recipient | null {
  const toAddr = routing?.contact ?? null
  return routing === null || toAddr === null || toAddr === "" ? null : { routing, toAddr }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * `filing.email`: sends an email filing (D6). The try claims the filing under the report's route lock, so
 * no `routeReport` or second delivery of the job can send between its outreach check and its packet;
 * the SMTP send itself runs after the lock is released. Every outcome is a guarded write from this
 * try's `running` row, and its effects run only when that write lands.
 */
export function makeFilingEmailHandler(deps: FilingEmailDeps): JobHandler {
  const { logger } = deps

  async function content(
    filing: FilingRecord,
    report: AdminReportRecord,
    routing: AdminReportRoutingRecord,
  ): Promise<FilingEmailContent> {
    const media = await deps.reports.listMedia(report.id)
    const publiclyVisible = isPubliclyVisibleStatus(report.status) && report.visibility === "public"
    const links: PacketMediaLink[] = []
    for (const m of media) {
      links.push({
        id: m.id,
        kind: m.kind,
        url: await deps.presignPacketMedia(m.r2Key, publiclyVisible),
      })
    }
    const defaults = deps.forwardTemplates !== undefined ? await deps.forwardTemplates.get() : null
    const templates = {
      subject: firstTemplate(routing.forwardSubjectTemplate, defaults?.subjectTemplate),
      body: firstTemplate(routing.forwardBodyTemplate, defaults?.bodyTemplate),
    }
    const closing = ticketTextClosing(filing.ticketText)
    // {operatorNote} renders empty: a filing's note travels in the closing paragraph (D3).
    return pickFilingAttachments({
      media,
      storage: deps.storage,
      build: (attached) =>
        buildReportPacket(report, routing, links, null, templates, { attached, closing }),
    })
  }

  async function settle(
    filing: FilingRecord,
    attempt: number,
    set: Partial<FilingMutableFields>,
  ): Promise<boolean> {
    const moved = await deps.filings.transition(filing.id, {
      from: ["running"],
      attempts: attempt,
      set,
    })
    if (moved === null) {
      logger.warn(
        { filingId: filing.id, attempt, status: set.status },
        "filing.email outcome not written: the filing left running under this attempt",
      )
    }
    return moved !== null
  }

  async function succeed(filing: FilingRecord, attempt: number, threadId: string): Promise<void> {
    const { applied } = await deps.filingService.applyFilingSuccess({
      filingId: filing.id,
      from: { status: ["running"], attempts: attempt },
      outcome: "submitted",
      method: "email",
      mailThreadId: threadId,
    })
    if (!applied) {
      logger.warn(
        { filingId: filing.id, attempt, threadId },
        "filing.email delivered but the success was not recorded: the filing left running",
      )
    }
  }

  async function fail(
    job: JobHandlerArg,
    filing: FilingRecord,
    attempt: number,
    err: unknown,
  ): Promise<void> {
    // The city may or may not have it, so a second send could file it twice (D6).
    if (isOutboundSendDeadlineError(err)) {
      await settle(filing, attempt, { status: "needs_human", reason: "uncertain_submission" })
      return
    }
    if (isFinalJobAttempt(job)) {
      await settle(filing, attempt, {
        status: "needs_human",
        reason: "portal_error",
        reasonDetail: errorMessage(err).slice(0, FILING_REASON_DETAIL_MAX),
      })
      return
    }
    if (await settle(filing, attempt, { status: "queued" })) throw err
  }

  async function recordThread(
    filing: FilingRecord,
    attempt: number,
    threadId: string,
  ): Promise<boolean> {
    return filing.mailThreadId === threadId || settle(filing, attempt, { mailThreadId: threadId })
  }

  // Runs under the route lock, after the claim.
  async function prepare(
    filing: FilingRecord,
    attempt: number,
    recipient: Recipient,
    email: FilingEmailContent,
  ): Promise<Step> {
    const { routing, toAddr } = recipient
    const outreach = await deps.reports.getOutreach(filing.reportId, {
      packetsSince: filing.createdAt,
    })
    try {
      assertRoutable(outreach, toAddr)
    } catch (err) {
      // A send still in flight fails this try. Otherwise a packet since this filing reached the
      // recipient: an earlier try that sent and stopped before its outcome was written.
      if (outreach.sendInFlight === true || outreach.threadId === null) throw err
      return { kind: "delivered", threadId: outreach.threadId }
    }

    const knownThread = filing.mailThreadId ?? outreach.threadId
    const unsent =
      knownThread === null
        ? null
        : await deps.mail.latestUnsentPacketId(knownThread, filing.createdAt)
    if (knownThread !== null && unsent !== null) {
      if (!(await recordThread(filing, attempt, knownThread))) return { kind: "moved" }
      return {
        kind: "send",
        threadId: knownThread,
        deliver: (opts) =>
          deps.outboundMail.redeliverReportPacket(
            { threadId: knownThread, messageId: unsent, attachments: email.attachments },
            opts,
          ),
      }
    }

    const prepared = await deps.outboundMail.prepareReportToJurisdiction({
      reportId: filing.reportId,
      geoid: routing.geoid,
      org: routing.dept,
      toAddr,
      subject: email.packet.subject,
      text: email.packet.text,
      html: email.packet.html,
      attachments: email.attachments,
      audit: {
        actorId: filing.createdBy,
        action: "report.routed",
        target: `report:${filing.reportId}`,
      },
    })
    if (!(await recordThread(filing, attempt, prepared.thread.id))) return { kind: "moved" }
    return { kind: "send", threadId: prepared.thread.id, deliver: (opts) => prepared.deliver(opts) }
  }

  async function lateSuccess(filing: FilingRecord, threadId: string): Promise<void> {
    const { applied } = await deps.filingService.applyFilingSuccess({
      filingId: filing.id,
      from: { status: ["needs_human"], reason: "uncertain_submission" },
      outcome: "submitted",
      method: "email",
      mailThreadId: threadId,
    })
    if (!applied) {
      logger.warn(
        { filingId: filing.id, threadId },
        "filing.email delivered late but the filing is no longer uncertain: left as it is",
      )
    }
  }

  return async (job) => {
    const filingId = filingIdOf(job.data)
    if (filingId === null) {
      logger.warn({ jobId: job.id }, "filing.email job without a filing id: dropped")
      return
    }
    const filing = await deps.filings.getById(filingId)
    if (filing === null || filing.status !== "queued") return
    if ((await deps.filings.getSettings()).paused) return
    const report = await deps.reports.getReport(filing.reportId)
    if (report === null || !isFileable(report)) {
      await deps.filings.transition(filing.id, { from: ["queued"], set: { status: "cancelled" } })
      return
    }
    const recipient = recipientOf(await deps.reports.getRouting(report.id))
    // Read before the lock, which holds a pooled connection that no photo download should keep.
    const email = recipient === null ? null : await content(filing, report, recipient.routing)
    const attempt = filing.attempts + 1

    const step = await deps.reports.withRouteLock(report.id, async (): Promise<Step> => {
      if ((await deps.filings.claim(filing.id, attempt)) === null) return { kind: "stale" }
      if (recipient === null || email === null) return { kind: "no_route" }
      try {
        return await prepare(filing, attempt, recipient, email)
      } catch (err) {
        return { kind: "failed", err }
      }
    })

    switch (step.kind) {
      case "stale":
      case "moved":
        return
      case "no_route":
        await settle(filing, attempt, { status: "needs_human", reason: "no_route" })
        return
      case "delivered":
        await succeed(filing, attempt, step.threadId)
        return
      case "failed":
        await fail(job, filing, attempt, step.err)
        return
      case "send":
        break
    }

    // A late success waits for this try's deadline outcome, so its guard sees the uncertain filing.
    let outcomeWritten: () => void = () => {}
    const deadlineOutcome = new Promise<void>((resolve) => {
      outcomeWritten = resolve
    })
    try {
      await step.deliver({
        onLateSuccess: async () => {
          await deadlineOutcome
          await lateSuccess(filing, step.threadId)
        },
      })
    } catch (err) {
      try {
        await fail(job, filing, attempt, err)
      } finally {
        outcomeWritten()
      }
      return
    }
    await succeed(filing, attempt, step.threadId)
  }
}
