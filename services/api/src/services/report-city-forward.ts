import { buildDiscussionForwardPacket } from "./admin/mail-format.js"
import { parseCityMention, effectiveJurisdictionHandle } from "./discussion-mentions.js"
import { replySubject, type OutboundMailService } from "./admin/outbound-mail-service.js"
import type { MailThreadRecord } from "./admin/mail-repository.drizzle.js"
import type { ReportForwardAudit } from "./report-forward-audit.drizzle.js"
import type { ReportJurisdictionView } from "./discussion-types.js"
import type { CounterStore } from "../abuse/counter-store.js"

export interface CityForwardContext {
  reportId: string
  category: string
  place: string | null
  jurisdiction: ReportJurisdictionView | null
  actorUserId: string
  actorDisplayName?: string | null
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

export interface CityForwardLogger {
  warn(obj: unknown, msg?: string): void
}

export interface CityForwardOptions {
  canForward?: CityForwardGate
  audit?: ReportForwardAudit
  messageId?: string
  logger?: CityForwardLogger
}

export function makeCityForwardThrottle(
  counters: CounterStore,
  logger?: CityForwardLogger,
): CityForwardGate {
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
    } catch (err) {
      // Fail closed: without the counters nothing bounds how often one sender can mail a city.
      logger?.warn({ err, reportId, geoid }, "city forward throttle unavailable; forward skipped")
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
  if (jurisdiction === null)
    return { mentioned: false, geoid: null, forwarded: false, forwardedAt: null }
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
  const thread = await existingReportThread(outboundMail, ctx.reportId, opts.logger)
  if (thread === null) {
    return { mentioned: true, geoid, forwarded: false, forwardedAt: null }
  }
  if (
    opts.canForward !== undefined &&
    !(await opts.canForward(ctx.reportId, geoid, ctx.actorUserId))
  ) {
    return { mentioned: true, geoid, forwarded: false, forwardedAt: null }
  }
  const packet = buildDiscussionForwardPacket(
    {
      reportId: ctx.reportId,
      category: ctx.category,
      place: ctx.place,
      org: jurisdiction.name,
      displayName: ctx.actorDisplayName ?? null,
    },
    body,
  )
  try {
    await outboundMail.appendOutbound(thread.id, {
      toAddr: contact,
      subject: discussionForwardSubject(thread.subject, packet.subject),
      body: packet.text,
      html: packet.html,
      kind: "discussion",
      eventMeta: { reportId: ctx.reportId, geoid },
    })
    await markForwarded(opts, geoid)
    return { mentioned: true, geoid, forwarded: true, forwardedAt: createdAt }
  } catch (err) {
    opts.logger?.warn({ err, reportId: ctx.reportId, geoid }, "city forward send failed")
    return { mentioned: true, geoid, forwarded: false, forwardedAt: null }
  }
}

export function discussionForwardSubject(threadSubject: string | null, fallback: string): string {
  if (threadSubject === null || threadSubject.trim() === "") return fallback
  return replySubject(threadSubject)
}

async function existingReportThread(
  outboundMail: OutboundMailService,
  reportId: string,
  logger: CityForwardLogger | undefined,
): Promise<MailThreadRecord | null> {
  try {
    return await outboundMail.findReportThread(reportId)
  } catch (err) {
    logger?.warn({ err, reportId }, "city forward thread lookup failed; forward skipped")
    return null
  }
}

async function recordMention(opts: CityForwardOptions, geoid: string): Promise<void> {
  if (opts.audit === undefined || opts.messageId === undefined) return
  const messageId = opts.messageId
  await opts.audit
    .recordMention(messageId, geoid)
    .catch((err: unknown) =>
      opts.logger?.warn({ err, messageId, geoid }, "city forward mention audit write failed"),
    )
}

async function markForwarded(opts: CityForwardOptions, geoid: string): Promise<void> {
  if (opts.audit === undefined || opts.messageId === undefined) return
  const messageId = opts.messageId
  await opts.audit
    .markForwarded(messageId, geoid)
    .catch((err: unknown) =>
      opts.logger?.warn({ err, messageId, geoid }, "city forward delivery audit write failed"),
    )
}
