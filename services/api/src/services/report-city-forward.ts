import { buildDiscussionForwardPacket } from "./admin/mail-format.js"
import { parseCityMention, effectiveJurisdictionHandle } from "./discussion-mentions.js"
import type { OutboundMailService } from "./admin/outbound-mail-service.js"
import type { ReportForwardAudit } from "./report-forward-audit.drizzle.js"
import type { ReportJurisdictionView } from "./discussion-types.js"
import type { CounterStore } from "../abuse/counter-store.js"

export interface CityForwardContext {
  reportId: string
  category: string
  place: string | null
  jurisdiction: ReportJurisdictionView | null
  actorUserId: string
}

export const CITY_FORWARD_DEDUP_TTL_SECONDS = 10 * 60
export const CITY_FORWARD_WINDOW_SECONDS = 60 * 60
export const CITY_FORWARD_PER_SENDER_PER_HOUR = 3
export const CITY_FORWARD_PER_GEOID_PER_HOUR = 20

export interface CityForwardResult {
  mentioned: boolean
  geoid: string | null
  forwarded: boolean
  forwardedAt: Date | null
}

export type CityForwardGate = (
  reportId: string,
  geoid: string,
  actorUserId: string,
) => Promise<boolean>

export interface CityForwardOptions {
  canForward?: CityForwardGate
  audit?: ReportForwardAudit
  messageId?: string
}

export function makeCityForwardThrottle(counters: CounterStore): CityForwardGate {
  return async (reportId, geoid, actorUserId) => {
    try {
      const dedup = await counters.incr(
        `citfwd:dedup:${actorUserId}:${reportId}:${geoid}`,
        CITY_FORWARD_DEDUP_TTL_SECONDS,
      )
      if (dedup > 1) return false

      const perSender = await counters.incr(
        `citfwd:user:${actorUserId}`,
        CITY_FORWARD_WINDOW_SECONDS,
      )
      if (perSender > CITY_FORWARD_PER_SENDER_PER_HOUR) return false

      const perGeoid = await counters.incr(`citfwd:geoid:${geoid}`, CITY_FORWARD_WINDOW_SECONDS)
      if (perGeoid > CITY_FORWARD_PER_GEOID_PER_HOUR) return false

      return true
    } catch {
      return false
    }
  }
}

export async function forwardReportCityMention(
  outboundMail: OutboundMailService,
  ctx: CityForwardContext,
  body: string,
  createdAt: Date,
  opts: CityForwardOptions = {},
): Promise<CityForwardResult> {
  const jurisdiction = ctx.jurisdiction
  if (jurisdiction === null) return { mentioned: false, geoid: null, forwarded: false, forwardedAt: null }
  const handle = effectiveJurisdictionHandle(jurisdiction)
  if (handle === null || parseCityMention(body, handle) === null) {
    return { mentioned: false, geoid: jurisdiction.geoid, forwarded: false, forwardedAt: null }
  }
  const geoid = jurisdiction.geoid
  await recordMention(opts, geoid)
  const contact = jurisdiction.contactEmail
  if (contact === null || contact === "") {
    return { mentioned: true, geoid, forwarded: false, forwardedAt: null }
  }
  if (opts.canForward !== undefined && !(await opts.canForward(ctx.reportId, geoid, ctx.actorUserId))) {
    return { mentioned: true, geoid, forwarded: false, forwardedAt: null }
  }
  const packet = buildDiscussionForwardPacket(
    { reportId: ctx.reportId, category: ctx.category, place: ctx.place, org: jurisdiction.name },
    body,
  )
  try {
    await outboundMail.sendReportToJurisdiction({
      reportId: ctx.reportId,
      geoid,
      org: jurisdiction.name,
      toAddr: contact,
      subject: packet.subject,
      text: packet.text,
      html: packet.html,
    })
    await markForwarded(opts, geoid)
    return { mentioned: true, geoid, forwarded: true, forwardedAt: createdAt }
  } catch {
    return { mentioned: true, geoid, forwarded: false, forwardedAt: null }
  }
}

async function recordMention(opts: CityForwardOptions, geoid: string): Promise<void> {
  if (opts.audit === undefined || opts.messageId === undefined) return
  await opts.audit.recordMention(opts.messageId, geoid).catch(() => {})
}

async function markForwarded(opts: CityForwardOptions, geoid: string): Promise<void> {
  if (opts.audit === undefined || opts.messageId === undefined) return
  await opts.audit.markForwarded(opts.messageId, geoid).catch(() => {})
}
