/**
 * Thread correlation for inbound mail, split out of inbound-processor: match a reply to its outbound
 * thread (by token-fallback References/In-Reply-To), the jurisdiction-reply report side-effects, and the
 * Message-ID dedup key. The side-effects are best-effort (the caller swallows failures) so inbound
 * processing + the idempotency/delete flow are never broken by a report-repo hiccup.
 */

import { createHash } from "node:crypto"
import type { Container } from "../../di.js"
import type { ParsedMail } from "@civfix/shared/interfaces"
import type { MailRepository, MailThreadRecord } from "./mail-repository.drizzle.js"
import { makeDrizzleAdminReportRepository } from "./admin-report-repository.drizzle.js"
import type { AdminReportRepository } from "./admin-report-service.js"

/**
 * Find a thread by the In-Reply-To / References headers an inbound reply echoes back (the fallback when
 * the plus-address token is stripped). Asks the mail repo for a thread carrying any of those ids as an
 * OUTBOUND Message-ID. Returns null when none correlate.
 */
export async function findThreadByReferences(
  mailRepo: MailRepository,
  mail: ParsedMail,
): Promise<MailThreadRecord | null> {
  const ids: string[] = []
  if (mail.inReplyTo && mail.inReplyTo.length > 0) ids.push(mail.inReplyTo)
  for (const ref of parseMessageIdList(mail.headers["references"])) ids.push(ref)
  if (ids.length === 0) return null
  return mailRepo.findThreadByOutboundMessageIds(ids)
}

/** Split a References-style header value into its Message-IDs (`<a@x> <b@y>` -> [..]); only @-bearing tokens. */
export function parseMessageIdList(value: string | undefined): string[] {
  if (!value || value.length === 0) return []
  const out: string[] = []
  const re = /<[^>]+>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(value)) !== null) out.push(m[0])
  if (out.length === 0) {
    // A header may carry a bare (unbracketed) id; keep only @-bearing tokens so free-text in a malformed
    // References header doesn't widen the IN(...) lookup with non-Message-ID noise.
    for (const token of value.split(/\s+/)) {
      const t = token.trim()
      if (t.length > 0 && t.includes("@")) out.push(t)
    }
  }
  return out
}

/**
 * Best-effort side-effects when a jurisdiction reply lands on a per-report outreach thread (#40): post the
 * reply to the report timeline (advancing published|acknowledged -> in_progress, else a system 'reply'
 * row), notify the original reporter (in-app), and flip the thread status to 'replied'. STRICTLY
 * best-effort: any failure is swallowed by the caller so inbound processing + the delete flow survive.
 */
export async function onJurisdictionReply(
  container: Container,
  injectedReportRepo: AdminReportRepository | undefined,
  mailRepo: MailRepository,
  thread: MailThreadRecord,
  mail: ParsedMail,
): Promise<void> {
  const reportId = thread.reportId
  if (reportId === null) return
  // Resolve the report repo lazily (only reached for a per-report thread): injected in tests, else the
  // Drizzle repo over the live sql.
  const reportRepo = injectedReportRepo ?? makeDrizzleAdminReportRepository(container.getDb().sql)
  const record = await reportRepo.getReport(reportId)
  if (!record) return

  const preview = replyPreview(mail.text ?? mail.html ?? "")
  const note = `Jurisdiction replied — ${preview}`

  // Advance a live (published/acknowledged) report to in_progress with the reply note; otherwise just
  // record a system 'reply' timeline row (no status change, e.g. an already-resolved report).
  if (record.status === "published" || record.status === "acknowledged") {
    await reportRepo.setStatus(reportId, { status: "in_progress", note, actorId: null })
  } else {
    await reportRepo.appendSystemTimeline(reportId, { note, kind: "reply" })
  }

  const reporterUserId = record.reporter?.id
  if (reporterUserId && reporterUserId !== "") {
    await reportRepo.notifyReporter({
      reportId,
      reporterUserId,
      title: "Your report got a response",
      body: preview,
      link: `/reports/${reportId}`,
    })
  }

  await mailRepo.setThreadStatus(thread.id, "replied")
}

/** First ~140 chars of an inbound reply body, whitespace-collapsed, for the timeline note + notification. */
export function replyPreview(body: string): string {
  const collapsed = body.replace(/\s+/g, " ").trim()
  return collapsed.length > 140 ? `${collapsed.slice(0, 140)}…` : collapsed
}

/**
 * The dedup key: the RFC822 Message-ID when present, else a stable hash of from/date/subject/body-length
 * so a re-delivered email without a Message-ID still collides. Never null (the columns dedup on it).
 */
export function resolveMessageId(mail: ParsedMail): string {
  if (mail.messageId && mail.messageId.length > 0) return mail.messageId
  const basis = [
    mail.from?.address ?? "",
    mail.headers["date"] ?? "",
    mail.subject ?? "",
    String((mail.text ?? mail.html ?? "").length),
  ].join("|")
  return `derived:${createHash("sha256").update(basis).digest("hex")}`
}
