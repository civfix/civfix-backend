
import type { Container } from "../../di.js"
import type { Sql } from "../../db/client.js"
import type { ParsedMail } from "@civfix/shared/interfaces"
import type { MailRepository } from "./mail-repository.drizzle.js"
import {
  JURISDICTION_DISCOVERY_JOB,
  type JurisdictionDiscoveryJob,
} from "../../services/jurisdiction-service.js"

const DSN_SCAN_PREFIX_BYTES = 64 * 1024

export interface BounceDetection {
  isBounce: boolean
  failedRecipient: string | null
  originalMessageId: string | null
}

export function detectBounce(mail: ParsedMail): BounceDetection {
  const fromAddr = mail.from?.address ?? ""
  const contentType = mail.headers["content-type"] ?? ""
  const failedHeader = mail.headers["x-failed-recipients"] ?? ""
  const isBounce =
    /(mailer-daemon|postmaster)@/i.test(fromAddr) ||
    /report-type["']?\s*[=:]\s*["']?delivery-status/i.test(contentType) ||
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

export async function handleBounce(
  container: Container,
  mailRepo: MailRepository,
  bounce: BounceDetection,
): Promise<void> {
  if (bounce.originalMessageId === null) return
  if (bounce.failedRecipient === null) return
  const thread = await mailRepo
    .findThreadByOutboundMessageIds([bounce.originalMessageId])
    .catch(() => null)
  if (thread === null) return

  const sql = container.getDb().sql
  const ownsRecipient = await threadSentTo(sql, thread.id, bounce.failedRecipient).catch(() => false)
  if (!ownsRecipient) return

  await mailRepo
    .recordEvent({
      threadId: thread.id,
      type: "bounced",
      meta: { failedRecipient: bounce.failedRecipient },
    })
    .catch(() => {})
  await mailRepo.setThreadStatus(thread.id, "bounced").catch(() => {})

  const geoid = thread.jurisdictionGeoid ?? (await geoidForContact(sql, bounce.failedRecipient))
  if (geoid === null) return
  await markBouncedContact(sql, bounce.failedRecipient, geoid).catch(() => {})
  const data: JurisdictionDiscoveryJob = { geoid }
  await container.jobs
    .enqueue(JURISDICTION_DISCOVERY_JOB, data, { singletonKey: geoid })
    .catch(() => {})
}

export async function threadSentTo(sql: Sql, threadId: string, email: string): Promise<boolean> {
  const rows = await sql<{ ok: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM mail_messages
      WHERE thread_id = ${threadId}
        AND direction = 'out'
        AND to_addr IS NOT NULL
        AND lower(to_addr) = lower(${email})
    ) AS ok
  `
  return rows[0]?.ok ?? false
}

export async function markBouncedContact(sql: Sql, email: string, geoid: string): Promise<void> {
  await sql`
    UPDATE jurisdiction_contacts
    SET bounced_at = now()
    WHERE lower(email) = lower(${email}) AND geoid = ${geoid}
  `
}

export async function geoidForContact(sql: Sql, email: string): Promise<string | null> {
  const rows = await sql<{ geoid: string }[]>`
    SELECT geoid FROM jurisdiction_contacts WHERE lower(email) = lower(${email}) LIMIT 1
  `
  return rows[0]?.geoid ?? null
}

export function extractEmail(value: string | null): string | null {
  if (value === null) return null
  const m = value.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)
  return m ? m[0] : null
}

export function matchLine(body: string, re: RegExp): string | null {
  const m = body.match(re)
  return m && m[1] ? m[1].trim() : null
}

export function matchBracketId(value: string | null): string | null {
  if (value === null) return null
  const m = value.match(/<[^>]+>/)
  return m ? m[0] : value.trim().length > 0 ? value.trim() : null
}
