/**
 * DSN/bounce detection + side-effects, split out of inbound-processor. A bounce is filed in the Inbox for
 * operator visibility (by the orchestrator) AND, the first time it is seen, correlated to its outbound
 * thread so the thread flips to 'bounced', a 'bounced' event is recorded, the contact is flagged, and
 * discovery is re-opened. Every side-effect is best-effort and never throws to the caller.
 */

import type { Container } from "../../di.js"
import type { Sql } from "../../db/client.js"
import type { ParsedMail } from "@civfix/shared/interfaces"
import type { MailRepository, MailThreadRecord } from "./mail-repository.drizzle.js"
import {
  JURISDICTION_DISCOVERY_JOB,
  type JurisdictionDiscoveryJob,
} from "../../services/jurisdiction-service.js"

/** A DSN body can be the full original message; cap what the linear extractors ever scan. */
const DSN_SCAN_PREFIX_BYTES = 64 * 1024

/** The result of bounce detection: whether the message is a DSN/bounce + the recovered correlation hints. */
export interface BounceDetection {
  isBounce: boolean
  failedRecipient: string | null
  originalMessageId: string | null
}

/**
 * Detect a delivery-status notification / bounce and recover the failed recipient + the original Message-ID
 * (pure). A message is a bounce when its From is a mailer-daemon/postmaster, OR its Content-Type is a
 * `report-type=delivery-status` multipart, OR it carries an X-Failed-Recipients header. The DSN body is
 * sliced to a bounded prefix before the line scans so a crafted multi-MiB bounce can't drive an unbounded
 * regex pass.
 */
export function detectBounce(mail: ParsedMail): BounceDetection {
  const fromAddr = mail.from?.address ?? ""
  const contentType = mail.headers["content-type"] ?? ""
  const failedHeader = mail.headers["x-failed-recipients"] ?? ""
  const isBounce =
    /(mailer-daemon|postmaster)@/i.test(fromAddr) ||
    /report-type=["']?delivery-status/i.test(contentType) ||
    failedHeader.length > 0
  if (!isBounce) {
    return { isBounce: false, failedRecipient: null, originalMessageId: null }
  }
  const body = (mail.text ?? mail.html ?? "").slice(0, DSN_SCAN_PREFIX_BYTES)
  const failedRecipient =
    extractEmail(failedHeader) ??
    extractEmail(matchLine(body, /^final-recipient:\s*(?:rfc822;)?\s*(.+)$/im)) ??
    extractEmail(matchLine(body, /^to:\s*(.+)$/im))
  const originalMessageId =
    matchBracketId(matchLine(body, /^original-message-id:\s*(.+)$/im)) ??
    matchBracketId(matchLine(body, /^message-id:\s*(.+)$/im))
  return { isBounce: true, failedRecipient, originalMessageId }
}

/** Best-effort bounce side-effects: correlate the thread, record the bounce, flag the contact, re-open discovery. */
export async function handleBounce(
  container: Container,
  mailRepo: MailRepository,
  bounce: BounceDetection,
): Promise<void> {
  // Correlate to a thread by the original Message-ID (the OUT message we sent); else skip the thread
  // side-effects (the contact is still flagged + the bounce filed in the Inbox by the orchestrator).
  let thread: MailThreadRecord | null = null
  if (bounce.originalMessageId !== null) {
    thread = await mailRepo
      .findThreadByOutboundMessageIds([bounce.originalMessageId])
      .catch(() => null)
  }
  if (thread !== null) {
    await mailRepo
      .recordEvent({
        threadId: thread.id,
        type: "bounced",
        meta: { failedRecipient: bounce.failedRecipient },
      })
      .catch(() => {})
    await mailRepo.setThreadStatus(thread.id, "bounced").catch(() => {})
  }

  // markContactBounced is a no-op for an unknown address; the discovery re-open enqueues the same
  // `jurisdiction.discovery` job the report-create path uses (singletonKey = geoid, idempotent), keyed off
  // the thread's jurisdiction when known.
  if (bounce.failedRecipient !== null) {
    const sql = container.getDb().sql
    await markBouncedContact(sql, bounce.failedRecipient).catch(() => {})
    const geoid = thread?.jurisdictionGeoid ?? (await geoidForContact(sql, bounce.failedRecipient))
    if (geoid !== null) {
      const data: JurisdictionDiscoveryJob = { geoid }
      await container.jobs
        .enqueue(JURISDICTION_DISCOVERY_JOB, data, { singletonKey: geoid })
        .catch(() => {})
    }
  }
}

/** Stamp bounced_at on every jurisdiction_contacts row carrying the address (the directory 'bounced' flag). */
export async function markBouncedContact(sql: Sql, email: string): Promise<void> {
  await sql`UPDATE jurisdiction_contacts SET bounced_at = now() WHERE email = ${email}`
}

/** Resolve the geoid of a jurisdiction_contacts row by its email (to re-open discovery), or null. */
export async function geoidForContact(sql: Sql, email: string): Promise<string | null> {
  const rows = await sql<{ geoid: string }[]>`
    SELECT geoid FROM jurisdiction_contacts WHERE email = ${email} LIMIT 1
  `
  return rows[0]?.geoid ?? null
}

/** Pull the first email address out of a free-text fragment (a header value or a DSN line), or null. */
export function extractEmail(value: string | null): string | null {
  if (value === null) return null
  const m = value.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)
  return m ? m[0] : null
}

/** Return the first capture group of a line-regex match against the body, or null. */
export function matchLine(body: string, re: RegExp): string | null {
  const m = body.match(re)
  return m && m[1] ? m[1].trim() : null
}

/** Extract a bracketed `<id@host>` Message-ID from a fragment (the value after a Message-ID: line), or null. */
export function matchBracketId(value: string | null): string | null {
  if (value === null) return null
  const m = value.match(/<[^>]+>/)
  return m ? m[0] : value.trim().length > 0 ? value.trim() : null
}
