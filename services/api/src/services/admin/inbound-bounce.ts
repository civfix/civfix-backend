import type { Container } from "../../di.js"
import type { ParsedMail } from "@civfix/shared/interfaces"
import { threadSentTo, type MailRepository } from "./mail-repository.drizzle.js"
import { BOUNCE_DISCOVERY_PENDING_META_KEY } from "./mail-repository.js"
import { geoidForContact, markBouncedContact } from "./jurisdiction-contacts-repository.drizzle.js"
import type { JurisdictionDiscoveryJob } from "../../services/jurisdiction-service.js"
import { JURISDICTION_DISCOVERY_JOB } from "../../lib/queue-names.js"
import { domainOf, domainsAligned, type MailAuthVerdict } from "../../adapters/inbound-mail.cf.js"

function ourMailDomains(container: Container): string[] {
  const env = container.env as { MAIL_FROM_OUTREACH?: string; MAIL_REPLY_DOMAIN?: string }
  const out: string[] = []
  const from = domainOf(env.MAIL_FROM_OUTREACH ?? null)
  if (from !== null) out.push(from)
  const reply = (env.MAIL_REPLY_DOMAIN ?? "").trim().toLowerCase()
  if (reply.length > 0 && !out.includes(reply)) out.push(reply)
  return out
}

const DSN_SCAN_PREFIX_BYTES = 64 * 1024

const DAEMON_LOCAL_PARTS: readonly string[] = ["mailer-daemon", "postmaster"]
const DAEMON_SENDER_RE = new RegExp(`(${DAEMON_LOCAL_PARTS.join("|")})@`, "i")
const DSN_CONTENT_TYPE_RE = /report-type["']?\s*[=:]\s*["']?delivery-status/i
// Two adjacent \s* around an optional token split a whitespace run every possible way, so a run of
// newlines after the label backtracks quadratically; nesting the second \s* keeps it linear.
const FINAL_RECIPIENT_LINE_RE = /^final-recipient:\s*(?:rfc822;\s*)?(.+)$/im
const TO_LINE_RE = /^to:\s*(.+)$/im
const ORIGINAL_MESSAGE_ID_LINE_RE = /^original-message-id:\s*(.+)$/im
const MESSAGE_ID_LINE_RE = /^message-id:\s*(.+)$/im
// A match found from inside a run of local-part characters is also found from the run's start, which
// is further left, so the lookbehind changes no first match; without it every position of a long run
// with no @ rescans the rest of the run (quadratic on an attacker-sized header).
const EMAIL_RE = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/
const BRACKET_ID_RE = /<[^>]+>/

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
    DAEMON_SENDER_RE.test(fromAddr) ||
    DSN_CONTENT_TYPE_RE.test(contentType) ||
    failedHeader.length > 0
  if (!isBounce) {
    return { isBounce: false, failedRecipient: null, originalMessageId: null }
  }
  const body = (mail.text ?? mail.html ?? "").slice(0, DSN_SCAN_PREFIX_BYTES)
  const failedRecipient =
    extractEmail(failedHeader) ??
    extractEmail(matchLine(body, FINAL_RECIPIENT_LINE_RE)) ??
    extractEmail(matchLine(body, TO_LINE_RE))
  const originalMessageId =
    matchBracketId(matchLine(body, ORIGINAL_MESSAGE_ID_LINE_RE)) ??
    matchBracketId(matchLine(body, MESSAGE_ID_LINE_RE))
  return { isBounce: true, failedRecipient, originalMessageId }
}

const PROVIDER_DAEMON_DOMAINS: readonly string[] = [
  "googlemail.com",
  "google.com",
  "outlook.com",
  "protection.outlook.com",
  "hotmail.com",
  "bounces.amazonses.com",
  "email.oraclecloud.com",
  "oracleemaildelivery.com",
]

// Anyone can open a mailbox at these providers, so sharing one with a jurisdiction contact proves
// nothing about the sender: only the contact's exact address does.
export const CONSUMER_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "ymail.com",
  "rocketmail.com",
  "aol.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "gmx.com",
  "gmx.net",
  "mail.com",
  "zoho.com",
  "yandex.com",
  "fastmail.com",
  "hey.com",
  "att.net",
  "sbcglobal.net",
  "bellsouth.net",
  "comcast.net",
  "verizon.net",
  "cox.net",
  "charter.net",
  "earthlink.net",
  "optonline.net",
  "centurylink.net",
  "windstream.net",
  "rr.com",
  "twc.com",
  "roadrunner.com",
  "frontier.com",
  "frontiernet.net",
  "juno.com",
  "netzero.net",
  "netzero.com",
  "mindspring.com",
  "embarqmail.com",
  "aim.com",
  "yahoo.co.uk",
  "yahoo.ca",
  "yahoo.com.au",
  "yahoo.fr",
  "yahoo.de",
  "hotmail.co.uk",
  "hotmail.fr",
  "hotmail.de",
  "live.co.uk",
  "outlook.de",
  "gmx.de",
  "gmx.at",
  "gmx.ch",
  "web.de",
  "t-online.de",
])

function isPlausibleBounceSender(input: {
  fromAddr: string | null
  failedRecipient: string
  ourMailDomains: readonly string[]
  authVerdict: MailAuthVerdict
}): boolean {
  if (input.authVerdict === "fail") return false
  const fromDomain = domainOf(input.fromAddr)
  if (fromDomain === null) return false
  const failedDomain = domainOf(input.failedRecipient)
  if (failedDomain !== null && domainsAligned(fromDomain, failedDomain)) return true
  for (const own of input.ourMailDomains) {
    if (own.length > 0 && domainsAligned(fromDomain, own)) return true
  }
  if (isDaemonLocalPart(input.fromAddr)) {
    for (const provider of PROVIDER_DAEMON_DOMAINS) {
      if (domainsAligned(fromDomain, provider)) return true
    }
  }
  return false
}

function isDaemonLocalPart(addr: string | null): boolean {
  if (addr === null) return false
  const at = addr.lastIndexOf("@")
  if (at <= 0) return false
  const local = addr.slice(0, at).trim().toLowerCase()
  return DAEMON_LOCAL_PARTS.includes(local)
}

export async function handleBounce(
  container: Container,
  mailRepo: MailRepository,
  bounce: BounceDetection,
  sender: { fromAddr: string | null; authVerdict: MailAuthVerdict },
): Promise<void> {
  if (bounce.originalMessageId === null) return
  if (bounce.failedRecipient === null) return
  if (
    !isPlausibleBounceSender({
      fromAddr: sender.fromAddr,
      failedRecipient: bounce.failedRecipient,
      ourMailDomains: ourMailDomains(container),
      authVerdict: sender.authVerdict,
    })
  ) {
    return
  }
  const thread = await mailRepo.findThreadByOutboundMessageIds([bounce.originalMessageId])
  if (thread === null) return

  const sql = container.getDb().sql
  const failedRecipient = bounce.failedRecipient
  const ownsRecipient = await threadSentTo(sql, thread.id, failedRecipient)
  if (!ownsRecipient) return

  // The 'bounced' event is the completion marker: a sweep re-drive after a partial failure repeats only
  // idempotent steps, and a duplicate delivery of a finished DSN does not overwrite a thread status an
  // operator has changed since. It is also the only bounce signal a legacy contact_emails address has,
  // so it is written before discovery is enqueued (a job that ran first would still see the address as
  // usable and skip). Until the enqueue lands it carries a pending flag, so a re-drive still enqueues.
  const marker = {
    threadId: thread.id,
    failedRecipient,
    originalMessageId: bounce.originalMessageId,
  }
  const state = await mailRepo.bounceEventState(marker)
  if (state === "complete") return

  const geoid = thread.jurisdictionGeoid ?? (await geoidForContact(sql, failedRecipient))
  if (state === "none") {
    await mailRepo.setThreadStatus(thread.id, "bounced")
    if (geoid !== null) await markBouncedContact(sql, failedRecipient, geoid)
    await mailRepo.recordEvent({
      threadId: thread.id,
      type: "bounced",
      meta: {
        failedRecipient,
        originalMessageId: bounce.originalMessageId,
        ...(geoid !== null ? { [BOUNCE_DISCOVERY_PENDING_META_KEY]: true } : {}),
      },
    })
    if (geoid === null) return
  }
  if (geoid !== null) {
    const data: JurisdictionDiscoveryJob = { geoid }
    await container.jobs.enqueue(JURISDICTION_DISCOVERY_JOB, data, { singletonKey: geoid })
  }
  await mailRepo.markBounceDiscoveryEnqueued(marker)
}

export function extractEmail(value: string | null): string | null {
  if (value === null) return null
  const m = value.match(EMAIL_RE)
  return m ? m[0] : null
}

function matchLine(body: string, re: RegExp): string | null {
  const m = body.match(re)
  return m && m[1] ? m[1].trim() : null
}

export function matchBracketId(value: string | null): string | null {
  if (value === null) return null
  // Every match ends at a ">", so text after the last one cannot change the result; cutting it off
  // stops a long run of "<" with no ">" from rescanning itself at every position.
  const lastClose = value.lastIndexOf(">")
  const m = lastClose === -1 ? null : value.slice(0, lastClose + 1).match(BRACKET_ID_RE)
  return m ? m[0] : value.trim().length > 0 ? value.trim() : null
}
