import { REPORT_TYPE_CODE } from "@civfix/contract"
import type { Jobs } from "@civfix/seams"
import type { MailAuthVerdict } from "../../adapters/inbound-mail.cf.js"
import { domainOfOrNull } from "../../adapters/mail-text.js"
import { FILING_CLASSIFY_JOB, FILING_QUEUE_OPTIONS } from "../../lib/queue-names.js"
import type { MailRepository } from "../admin/mail-repository.drizzle.js"
import { isConsumerMailDomain, normalizedMailbox } from "../admin/inbound-thread-correlation.js"
import type { FilingIngestSql } from "./filing-ingest-sql.drizzle.js"
import type { FilingRepository } from "./filing-repository.js"
import {
  FILING_CASE_TOKENS_MAX,
  type FilingMessageRecord,
  type FilingRecord,
} from "./filing-types.js"
import type { FilingClassifyJobData } from "./filings-worker.js"

export interface FilingCorrelatorDeps {
  filings: Pick<
    FilingRepository,
    | "getLatestByMailThread"
    | "getLatestSuccessfulForReport"
    | "findByCaseIds"
    | "findRoutes"
    | "insertMessageIfAbsent"
    | "getMessageByInboundEmailId"
    | "getMessageByMailMessageId"
    | "flagMessage"
  >
  ingest: Pick<FilingIngestSql, "reportIdByReferenceCode">
  mailRepo: Pick<MailRepository, "outboundRecipients">
  jobs: Pick<Jobs, "enqueue">
  /** FILING_AUTOMATIC_ENABLED (D10): with it off, nothing is sent to Claude. */
  automaticFiling: boolean
}

/** What linking a threaded reply needs: its filing is found by thread, with no code or route reads. */
export type FilingLinkDeps = Pick<FilingCorrelatorDeps, "filings" | "jobs" | "automaticFiling">

/** How much of a city message is read for codes and case ids, and sent to Claude. */
const CITY_TEXT_MAX_CHARS = 20_000

const CASE_TOKEN_RE = /[A-Za-z0-9-]+/g
const CASE_TOKEN_MIN = 5
const CASE_TOKEN_MAX = 64

const typeCodes = [...new Set(Object.values(REPORT_TYPE_CODE))].join("|")
// The line CivFix writes into every portal filing (D11), echoed back by the city's notification.
const FRAMING_LINE_RE = new RegExp(
  String.raw`Reported\s+by\s+a\s+resident\s+via\s+CivFix\s*[^\sA-Za-z0-9]?\s*ref\s*((?:${typeCodes})-\d+-\d{6,})(?![A-Za-z0-9])`,
  "gi",
)

interface CityText {
  subject: string
  /** The plain body; only its first 20,000 characters are read. */
  text: string
}

/** Whether the filings inbox is a To recipient or named in the raw Cc header (never the envelope). */
export function addressedToFilingsInbox(
  inbox: string,
  to: readonly { address: string }[],
  ccHeader: string | undefined,
): boolean {
  const wanted = inbox.toLowerCase()
  if (to.some((a) => a.address.toLowerCase() === wanted)) return true
  const escaped = wanted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  // The same mailbox boundaries the thread-token scan of the Cc header uses.
  return new RegExp(String.raw`(?<![^\s<,;:"])${escaped}(?![^\s>,;"])`, "i").test(ccHeader ?? "")
}

function readable(mail: CityText): string {
  return `${mail.subject}\n${mail.text.slice(0, CITY_TEXT_MAX_CHARS)}`
}

function caseTokens(text: string): string[] {
  const tokens = new Set<string>()
  for (const [token] of text.matchAll(CASE_TOKEN_RE)) {
    if (token.length < CASE_TOKEN_MIN || token.length > CASE_TOKEN_MAX) continue
    tokens.add(token)
    if (tokens.size >= FILING_CASE_TOKENS_MAX) break
  }
  return [...tokens]
}

/** D11's two steps: the framing line's reference code, then exactly one case id. */
async function findFiling(
  deps: FilingCorrelatorDeps,
  text: string,
): Promise<{ filing: FilingRecord; byCode: boolean } | null> {
  const codes = new Set([...text.matchAll(FRAMING_LINE_RE)].map((m) => m[1]!.toUpperCase()))
  if (codes.size === 1) {
    const reportId = await deps.ingest.reportIdByReferenceCode([...codes][0]!)
    const filing =
      reportId === null ? null : await deps.filings.getLatestSuccessfulForReport(reportId)
    if (filing !== null) return { filing, byCode: true }
  }
  const tokens = caseTokens(text)
  if (tokens.length === 0) return null
  const matches = await deps.filings.findByCaseIds(tokens)
  return matches.length === 1 ? { filing: matches[0]!, byCode: false } : null
}

/**
 * Filings-inbox trust (D11): DMARC pass from a hostname on the route's status-sender list. A filing on an
 * implicit email route has no list, so the sender must be who the filing was mailed to, the way
 * `isJurisdictionSender` judges a threaded reply but by exact hostname.
 */
async function isTrustedSender(
  deps: FilingCorrelatorDeps,
  filing: FilingRecord,
  from: string | null,
  authVerdict: MailAuthVerdict,
): Promise<boolean> {
  const host = domainOfOrNull(from)
  if (authVerdict !== "pass" || from === null || host === null) return false
  const routes =
    filing.geoid === null ? [] : await deps.filings.findRoutes(filing.geoid, filing.category)
  const route = routes.find((r) => r.category === filing.routeCategory)
  if (route !== undefined) {
    return route.statusSenderDomains.some((domain) => domain.toLowerCase() === host)
  }
  if (filing.channel !== "email" || filing.mailThreadId === null) return false
  const sender = normalizedMailbox(from)
  for (const recipient of await deps.mailRepo.outboundRecipients(filing.mailThreadId)) {
    const contactHost = domainOfOrNull(recipient)
    if (contactHost === null) continue
    if (isConsumerMailDomain(contactHost)) {
      if (normalizedMailbox(recipient) === sender) return true
    } else if (contactHost === host) {
      return true
    }
  }
  return false
}

/**
 * Settles a linked row: flags it, or sends a trusted, unflagged, unclassified row to Claude. A replay
 * reads the existing row back and runs this again, so an enqueue lost to a failure is sent on the next
 * delivery or sweep, and the short-policy queue keeps a row from having two jobs waiting.
 */
async function settleRow(
  deps: FilingLinkDeps,
  row: FilingMessageRecord,
  flag: boolean,
  mail: CityText,
  classify: boolean,
): Promise<void> {
  if (flag) {
    if (!row.flagged) await deps.filings.flagMessage(row.id)
    return
  }
  if (!classify || !deps.automaticFiling) return
  if (!row.trusted || row.flagged || row.classification !== null) return
  const data: FilingClassifyJobData = {
    filingMessageId: row.id,
    subject: mail.subject,
    text: mail.text.slice(0, CITY_TEXT_MAX_CHARS),
  }
  await deps.jobs.enqueue(FILING_CLASSIFY_JOB, data, {
    singletonKey: row.id,
    retryLimit: FILING_QUEUE_OPTIONS[FILING_CLASSIFY_JOB].retryLimit,
  })
}

/** A filings-inbox message stored as inbox row `inboundEmailId`: link it to its filing, if one matches. */
export async function correlateFilingsInboxMessage(
  deps: FilingCorrelatorDeps,
  input: CityText & { inboundEmailId: string; from: string | null; authVerdict: MailAuthVerdict },
): Promise<void> {
  const text = readable(input)
  const found = await findFiling(deps, text)
  if (found === null) return
  const { filing, byCode } = found
  const trusted = await isTrustedSender(deps, filing, input.from, input.authVerdict)
  // A framing line is copyable; a filing with a case id also needs that id in the message.
  const caseIdMissing = byCode && filing.caseId !== null && !text.includes(filing.caseId)
  const row =
    (await deps.filings.insertMessageIfAbsent({
      filingId: filing.id,
      inboundEmailId: input.inboundEmailId,
      trusted,
    })) ?? (await deps.filings.getMessageByInboundEmailId(input.inboundEmailId))
  if (row === null) return
  await settleRow(deps, row, !trusted || caseIdMissing, input, true)
}

/**
 * A reply on an email filing's thread (looked up by thread, so the report's resident @city discussion
 * gets no row). Trust is the thread's own verdict; an operator publishing a withheld reply never sends
 * it to Claude.
 */
export async function correlateFilingThreadReply(
  deps: FilingLinkDeps,
  input: CityText & {
    threadId: string
    mailMessageId: string
    unaffiliated: boolean
    publishedByOperator: boolean
  },
): Promise<void> {
  const filing = await deps.filings.getLatestByMailThread(input.threadId)
  if (filing === null) return
  const trusted = !input.unaffiliated
  const row =
    (await deps.filings.insertMessageIfAbsent({
      filingId: filing.id,
      mailMessageId: input.mailMessageId,
      trusted,
    })) ?? (await deps.filings.getMessageByMailMessageId(input.mailMessageId))
  if (row === null) return
  await settleRow(deps, row, !trusted, input, !input.publishedByOperator)
}
