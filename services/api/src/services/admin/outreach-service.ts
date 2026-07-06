
import type { ReportCategory } from "@civfix/shared"
import type { MailRepository } from "./mail-repository.drizzle.js"
import type { OutboundMailService } from "./outbound-mail-service.js"

export interface OutreachDigest {
  geoid: string
  org: string | null
  toAddr: string
  perCategory: Partial<Record<ReportCategory, number>>
  total: number
  oldestWaitingAt: Date | null
}

export interface OutreachRepository {
  loadDigest(geoid: string): Promise<OutreachDigest | null>
  listCandidateGeoids(): Promise<string[]>
  claimOutreachWindow?(
    geoid: string,
    window: { at: Date; windowStart: Date },
  ): Promise<boolean>
}

export const OUTREACH_CATEGORIES: readonly ReportCategory[] = [
  "trash",
  "recycling",
  "graffiti",
  "hazard",
  "encampment",
  "water",
  "other",
]

const CATEGORY_LABELS: Record<ReportCategory, string> = {
  trash: "Trash",
  recycling: "Recycling",
  graffiti: "Graffiti",
  hazard: "Hazard",
  encampment: "Encampment",
  water: "Water",
  other: "Other",
}

export function isThrottled(
  lastOutreachAt: Date | null,
  now: Date,
  throttleDays: number,
): boolean {
  if (lastOutreachAt === null) return false
  const windowMs = throttleDays * 24 * 60 * 60 * 1000
  return now.getTime() - lastOutreachAt.getTime() < windowMs
}

export function digestSubject(digest: OutreachDigest): string {
  const noun = digest.total === 1 ? "report" : "reports"
  const where = digest.org && digest.org.length > 0 ? ` in ${digest.org}` : ""
  return `civfix: ${digest.total} ${noun}${where} awaiting your attention`
}

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

export interface OutreachRunResult {
  geoid: string
  sent: boolean
  skipped?: "throttled" | "suppressed" | "nothing-to-send"
  reportCount: number
  threadId?: string
  error?: string
}

export interface OutreachServiceDeps {
  outreachRepo: OutreachRepository
  mailRepo: MailRepository
  outboundMail: OutboundMailService
  throttleDays: number
  now?: () => Date
}

export interface OutreachService {
  runForGeoid(geoid: string): Promise<OutreachRunResult>
  runSweep(): Promise<OutreachRunResult[]>
}

export function makeOutreachService(deps: OutreachServiceDeps): OutreachService {
  const now = deps.now ?? (() => new Date())

  async function sendDigest(digest: OutreachDigest): Promise<string> {
    const thread = await deps.outboundMail.sendToCity({
      geoid: digest.geoid,
      toAddr: digest.toAddr,
      subject: digestSubject(digest),
      body: digestBody(digest),
      org: digest.org,
    })
    return thread.id
  }

  async function runForGeoid(geoid: string): Promise<OutreachRunResult> {
    const state = await deps.mailRepo.getOutreachState(geoid)
    if (state?.suppressed) {
      return { geoid, sent: false, skipped: "suppressed", reportCount: 0 }
    }
    if (isThrottled(state?.lastOutreachAt ?? null, now(), deps.throttleDays)) {
      return { geoid, sent: false, skipped: "throttled", reportCount: 0 }
    }

    const digest = await deps.outreachRepo.loadDigest(geoid)
    if (digest === null || digest.total === 0) {
      return { geoid, sent: false, skipped: "nothing-to-send", reportCount: 0 }
    }

    const at = now()
    const claim = deps.outreachRepo.claimOutreachWindow
    if (claim) {
      const windowStart = new Date(at.getTime() - deps.throttleDays * 24 * 60 * 60 * 1000)
      const won = await claim(geoid, { at, windowStart })
      if (!won) {
        return { geoid, sent: false, skipped: "throttled", reportCount: 0 }
      }
      const threadId = await sendDigest(digest)
      return { geoid, sent: true, reportCount: digest.total, threadId }
    }

    const threadId = await sendDigest(digest)
    await deps.mailRepo.setOutreachState(geoid, { lastOutreachAt: at })
    return { geoid, sent: true, reportCount: digest.total, threadId }
  }

  async function runSweep(): Promise<OutreachRunResult[]> {
    const geoids = await deps.outreachRepo.listCandidateGeoids()
    const results: OutreachRunResult[] = []
    for (const geoid of geoids) {
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
