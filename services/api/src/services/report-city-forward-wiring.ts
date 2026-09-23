import type { ChatMessageDTO } from "@civfix/shared"
import type { Container } from "../di.js"
import { makeOutboundMailService, type OutboundMailService } from "./admin/outbound-mail-service.js"
import { makeDrizzleMailRepository } from "./admin/mail-repository.drizzle.js"
import { makeReportForwardAudit, type ReportForwardAudit } from "./report-forward-audit.drizzle.js"
import { makeDrizzleDiscussionRepository } from "./discussion-repository.drizzle.js"
import type { DiscussionRepository } from "./discussion-types.js"
import {
  forwardReportCityMention,
  makeCityForwardThrottle,
  type CityForwardGate,
  type CityForwardLogger,
} from "./report-city-forward.js"

export type ReportCityForwardEffect = (
  reportId: string,
  message: ChatMessageDTO,
  actorUserId: string,
) => Promise<void>

export interface ReportCityForwardWiringOverrides {
  getReportRepo?: () => DiscussionRepository
  canForward?: CityForwardGate
  logger?: CityForwardLogger
}

export const NOOP_REPORT_CITY_FORWARD: ReportCityForwardEffect = () => Promise.resolve()

export function makeContainerReportCityForward(
  container: Container,
  overrides: ReportCityForwardWiringOverrides = {},
): ReportCityForwardEffect {
  let outboundMail: OutboundMailService | undefined
  let audit: ReportForwardAudit | undefined
  let reportRepo: DiscussionRepository | undefined
  let throttle: CityForwardGate | undefined

  const canForward = (): CityForwardGate =>
    overrides.canForward ??
    (throttle ??= makeCityForwardThrottle(container.getCounterStore(), overrides.logger))

  const getReportRepo = (): DiscussionRepository =>
    overrides.getReportRepo?.() ??
    (reportRepo ??= makeDrizzleDiscussionRepository(container.getDb().sql))

  return async (reportId, message, actorUserId) => {
    outboundMail ??= makeOutboundMailService({
      repo: makeDrizzleMailRepository(container.getDb().sql),
      mailer: container.mailer,
      env: {
        MAIL_FROM_OUTREACH: container.env.MAIL_FROM_OUTREACH,
        MAIL_REPLY_DOMAIN: container.env.MAIL_REPLY_DOMAIN,
      },
    })
    audit ??= makeReportForwardAudit(container.getDb().sql)
    const report = await getReportRepo().findReportForDiscussion(reportId)
    if (report === null) return
    const body = typeof message.body === "string" ? message.body : ""
    await forwardReportCityMention(
      outboundMail,
      {
        reportId,
        category: report.category,
        place: report.place,
        jurisdiction: report.jurisdiction,
        actorUserId,
        actorDisplayName: message.from?.name ?? null,
      },
      body,
      new Date(message.createdAt),
      {
        canForward: canForward(),
        audit,
        messageId: message.id,
        ...(overrides.logger !== undefined ? { logger: overrides.logger } : {}),
      },
    )
  }
}
