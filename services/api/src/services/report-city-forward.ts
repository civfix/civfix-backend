import { buildDiscussionForwardPacket } from "./admin/mail-format.js"
import { parseCityMention } from "./discussion-mentions.js"
import { effectiveJurisdictionHandle } from "./discussion-projection.js"
import type { OutboundMailService } from "./admin/outbound-mail-service.js"
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
  const contact = jurisdiction.contactEmail
  if (contact === null || contact === "") {
    return { mentioned: true, geoid: jurisdiction.geoid, forwarded: false, forwardedAt: null }
  }
  if (opts.canForward !== undefined && !opts.canForward(ctx.reportId, jurisdiction.geoid)) {
    return { mentioned: true, geoid: jurisdiction.geoid, forwarded: false, forwardedAt: null }
  }
  const packet = buildDiscussionForwardPacket(
    { reportId: ctx.reportId, category: ctx.category, place: ctx.place, org: jurisdiction.name },
    body,
  )
  try {
    await outboundMail.sendReportToJurisdiction({
      reportId: ctx.reportId,
      geoid: jurisdiction.geoid,
      org: jurisdiction.name,
      toAddr: contact,
      subject: packet.subject,
      text: packet.text,
      html: packet.html,
    })
    return { mentioned: true, geoid: jurisdiction.geoid, forwarded: true, forwardedAt: createdAt }
  } catch {
    return { mentioned: true, geoid: jurisdiction.geoid, forwarded: false, forwardedAt: null }
  }
}
