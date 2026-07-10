import { buildDiscussionForwardPacket } from "./admin/mail-format.js"
import { parseCityMention, effectiveJurisdictionHandle } from "./discussion-mentions.js"
import type { OutboundMailService } from "./admin/outbound-mail-service.js"
import type { ReportForwardAudit } from "./report-forward-audit.drizzle.js"
import type { ReportJurisdictionView } from "./discussion-types.js"

export interface CityForwardContext {
  reportId: string
  category: string
  place: string | null
  jurisdiction: ReportJurisdictionView | null
}

export interface CityForwardResult {
  mentioned: boolean
  geoid: string | null
  forwarded: boolean
  forwardedAt: Date | null
}

export interface CityForwardOptions {
  canForward?: (reportId: string, geoid: string) => boolean
  // D-C4 audit seam. When both are supplied and the body @mentions the report's jurisdiction, an audit row
  // is written to report_message_forwards (forwarded_at NULL) BEFORE the send is attempted, and stamped
  // forwarded_at on a SUCCESSFUL forward. A message that mentions @city but has NO city contact (cannot
  // forward) STILL writes the mentioned-but-not-forwarded row. Audit writes are best-effort: a failure
  // never rejects the message (the message already persisted). Omit `audit`/`messageId` to skip auditing
  // (e.g. the old discussion path, whose audit rode discussion_message_mentions).
  audit?: ReportForwardAudit
  messageId?: string
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
  // From here the message @mentions the report's jurisdiction. Record the audit row (forwarded_at NULL)
  // BEFORE attempting to forward, so a mention with no city contact (or a deduped/failed send) is still
  // captured as mentioned-but-not-forwarded. Best-effort: never let an audit-write failure reject the
  // already-persisted message.
  const geoid = jurisdiction.geoid
  await recordMention(opts, geoid)
  const contact = jurisdiction.contactEmail
  if (contact === null || contact === "") {
    return { mentioned: true, geoid, forwarded: false, forwardedAt: null }
  }
  if (opts.canForward !== undefined && !opts.canForward(ctx.reportId, geoid)) {
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

// Best-effort audit helpers: no-op unless BOTH audit and messageId were supplied, and never throw (an
// audit-write failure must not reject the chat message, which already persisted).
async function recordMention(opts: CityForwardOptions, geoid: string): Promise<void> {
  if (opts.audit === undefined || opts.messageId === undefined) return
  try {
    await opts.audit.recordMention(opts.messageId, geoid)
  } catch {
    // swallowed: the message is already persisted; a missing audit row degrades gracefully.
  }
}

async function markForwarded(opts: CityForwardOptions, geoid: string): Promise<void> {
  if (opts.audit === undefined || opts.messageId === undefined) return
  try {
    await opts.audit.markForwarded(opts.messageId, geoid)
  } catch {
    // swallowed: the forward itself succeeded; only the forwarded_at stamp is best-effort.
  }
}
