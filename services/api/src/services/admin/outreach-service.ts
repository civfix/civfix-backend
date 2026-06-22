/**
 * Outreach service (Phase 2): the digest pipeline the outreach.digest pg-boss job drives.
 *
 * The platform sends AT MOST one outreach email per jurisdiction per OUTREACH_THROTTLE_DAYS. When new
 * reports accumulate in a jurisdiction that has a routing contact, this service aggregates the waiting
 * reports into ONE digest email and sends it to the municipal contact via the OutboundMailService (which
 * records the out thread/message + a 'sent' mail_events row), then stamps outreach_state.last_outreach_at
 * so the throttle window starts. Two entry points back the job:
 *
 *   - runForGeoid(geoid)  the targeted run discovery's "Save & route" enqueues (singletonKey=geoid).
 *                         Sends that one jurisdiction's digest if it is due (not throttled / suppressed)
 *                         and has both waiting reports AND a contact.
 *   - runSweep()          the daily cron sweep. Lists every jurisdiction with waiting reports + a contact
 *                         that is due, and runs each through the same per-jurisdiction path.
 *
 * THROTTLE (defense in depth): the discovery service ALSO throttles before enqueueing, but this service
 * re-checks outreach_state.last_outreach_at + OUTREACH_THROTTLE_DAYS (and the manual `suppressed` flag)
 * so a second enqueue inside the window, or a cron tick, never double-sends. The throttle state is read +
 * written through the MailRepository (getOutreachState / setOutreachState); the per-jurisdiction digest
 * aggregation + contact resolution + candidate listing go through the OutreachRepository seam, so the
 * whole service is unit-testable with the in-memory repos + a FakeMailer (no DB, no Docker).
 *
 * AUDIT: the cron/job context has no operator userId, so a digest send is a SYSTEM action. The service
 * records the deliverability 'sent' event (via OutboundMailService) and returns the per-run outcome so the
 * job wrapper can write a single system audit row (outreach.digest_sent) per jurisdiction sent.
 */

import type { ReportCategory } from "@civfix/shared"
import type { MailRepository } from "./mail-repository.drizzle.js"
import type { OutboundMailService } from "./outbound-mail-service.js"

/**
 * The per-jurisdiction outreach digest: the waiting-report aggregate + the resolved municipal routing
 * contact the email is sent to. `toAddr` is the resolved contact (category-agnostic default / first
 * usable contact); `org` the display label; `perCategory` the waiting counts; `total` their sum.
 */
export interface OutreachDigest {
  geoid: string
  org: string | null
  toAddr: string
  perCategory: Partial<Record<ReportCategory, number>>
  total: number
  /** Oldest waiting-report timestamp (drives the digest copy "oldest waiting since ..."). */
  oldestWaitingAt: Date | null
}

/**
 * Persistence seam for the outreach pipeline's READ side. The Drizzle impl runs raw SQL over reports +
 * jurisdiction_contacts + jurisdictions; the in-memory impl backs the offline unit tests. The throttle
 * state itself lives on the MailRepository, so this seam never reads/writes outreach_state.
 */
export interface OutreachRepository {
  /**
   * Build the digest for one geoid: aggregate its waiting reports (non-deleted, still open) per category
   * and resolve the routing contact (category-agnostic default -> any per-category contact -> legacy
   * jurisdictions.contact_emails[]). Returns null when there is NOTHING to send: no waiting reports, or
   * no usable contact address.
   */
  loadDigest(geoid: string): Promise<OutreachDigest | null>
  /**
   * List the geoids that currently have waiting reports AND a usable routing contact (the cron sweep
   * candidates). Throttle/suppression is applied by the service per geoid, not here.
   */
  listCandidateGeoids(): Promise<string[]>
}

/** The 6 canonical categories in display order (local copy; the digest body lists them in this order). */
export const OUTREACH_CATEGORIES: readonly ReportCategory[] = [
  "trash",
  "recycling",
  "graffiti",
  "hazard",
  "water",
  "other",
]

/** Human label per category (kept local so the digest body needs no cross-import). */
const CATEGORY_LABELS: Record<ReportCategory, string> = {
  trash: "Trash",
  recycling: "Recycling",
  graffiti: "Graffiti",
  hazard: "Hazard",
  water: "Water",
  other: "Other",
}

/**
 * Whether a jurisdiction is THROTTLED as of `now`: it sent within the last `throttleDays`. A null
 * last-outreach time (never sent) is never throttled. Pure + clock-injected for deterministic tests.
 */
export function isThrottled(
  lastOutreachAt: Date | null,
  now: Date,
  throttleDays: number,
): boolean {
  if (lastOutreachAt === null) return false
  const windowMs = throttleDays * 24 * 60 * 60 * 1000
  return now.getTime() - lastOutreachAt.getTime() < windowMs
}

/** The digest email subject (one line, counts the waiting reports). */
export function digestSubject(digest: OutreachDigest): string {
  const noun = digest.total === 1 ? "report" : "reports"
  const where = digest.org && digest.org.length > 0 ? ` in ${digest.org}` : ""
  return `civfix: ${digest.total} ${noun}${where} awaiting your attention`
}

/**
 * The digest email body: a short intro + a per-category breakdown of the waiting reports. Plain text
 * (the Mailer renders the generic subject + message branch). Deterministic given the aggregate.
 */
export function digestBody(digest: OutreachDigest): string {
  const lines: string[] = []
  const where = digest.org && digest.org.length > 0 ? digest.org : "your jurisdiction"
  lines.push(
    `Hello,\n\nResidents have filed ${digest.total} report(s) in ${where} that are awaiting action. ` +
      `A breakdown by category:`,
  )
  lines.push("")
  for (const category of OUTREACH_CATEGORIES) {
    const count = digest.perCategory[category] ?? 0
    if (count > 0) lines.push(`- ${CATEGORY_LABELS[category]}: ${count}`)
  }
  lines.push("")
  lines.push(
    "Reply to this email to coordinate with the civfix team. Thank you for keeping the community clean.",
  )
  return lines.join("\n")
}

/** The outcome of one jurisdiction's digest run (returned so the job can audit + the test can assert). */
export interface OutreachRunResult {
  geoid: string
  /** True when a digest was actually sent (false when throttled / suppressed / nothing to send). */
  sent: boolean
  /** Why it was skipped (when sent=false): "throttled" | "suppressed" | "nothing-to-send". */
  skipped?: "throttled" | "suppressed" | "nothing-to-send"
  /** The number of waiting reports aggregated into the digest (0 when nothing was sent). */
  reportCount: number
  /** The mail thread the digest was appended to (when sent). */
  threadId?: string
  /** Set when runForGeoid threw inside the sweep (the per-geoid failure was caught so the sweep continued). */
  error?: string
}

export interface OutreachServiceDeps {
  /** Read side: digest aggregation + contact resolution + candidate listing. */
  outreachRepo: OutreachRepository
  /** Throttle state (outreach_state) read/write. */
  mailRepo: MailRepository
  /** Sends the digest + records the out thread/message + 'sent' event. */
  outboundMail: OutboundMailService
  /** Throttle window in days (env.OUTREACH_THROTTLE_DAYS). */
  throttleDays: number
  /** Injectable clock (defaults to Date.now) so the throttle window is deterministic in tests. */
  now?: () => Date
}

export interface OutreachService {
  /** Run the digest for one jurisdiction if it is due. The targeted "Save & route" path. */
  runForGeoid(geoid: string): Promise<OutreachRunResult>
  /** Run the daily sweep across every due candidate jurisdiction. The cron path. */
  runSweep(): Promise<OutreachRunResult[]>
}

export function makeOutreachService(deps: OutreachServiceDeps): OutreachService {
  const now = deps.now ?? (() => new Date())

  async function runForGeoid(geoid: string): Promise<OutreachRunResult> {
    // 1. Throttle / suppression gate (defense in depth on top of discovery's enqueue throttle).
    const state = await deps.mailRepo.getOutreachState(geoid)
    if (state?.suppressed) {
      return { geoid, sent: false, skipped: "suppressed", reportCount: 0 }
    }
    if (isThrottled(state?.lastOutreachAt ?? null, now(), deps.throttleDays)) {
      return { geoid, sent: false, skipped: "throttled", reportCount: 0 }
    }

    // 2. Aggregate the waiting reports + resolve the contact. Nothing to send -> skip without stamping.
    const digest = await deps.outreachRepo.loadDigest(geoid)
    if (digest === null || digest.total === 0) {
      return { geoid, sent: false, skipped: "nothing-to-send", reportCount: 0 }
    }

    // 3. Send the single digest via the OutboundMailService (rolling per-geoid thread + 'sent' event).
    const thread = await deps.outboundMail.sendToCity({
      geoid: digest.geoid,
      toAddr: digest.toAddr,
      subject: digestSubject(digest),
      body: digestBody(digest),
      org: digest.org,
    })

    // 4. Stamp the throttle window so the next enqueue / cron tick inside it is a no-op.
    // The throttle (read state -> send -> stamp) is NOT atomic, so two truly-concurrent runs for one geoid
    // could both pass the gate and double-send. The real guard against that is the pg-boss singletonKey=geoid
    // on the targeted job (one in-flight per geoid) plus the daily-cron cadence; this in-service throttle is
    // defense-in-depth for the serial case, not a concurrency lock.
    await deps.mailRepo.setOutreachState(geoid, { lastOutreachAt: now() })

    return { geoid, sent: true, reportCount: digest.total, threadId: thread.id }
  }

  async function runSweep(): Promise<OutreachRunResult[]> {
    const geoids = await deps.outreachRepo.listCandidateGeoids()
    const results: OutreachRunResult[] = []
    for (const geoid of geoids) {
      // Each jurisdiction is independent; a failure on one must NOT abort the sweep for the rest.
      try {
        results.push(await runForGeoid(geoid))
      } catch (err) {
        results.push({
          geoid,
          sent: false,
          reportCount: 0,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    return results
  }

  return { runForGeoid, runSweep }
}
