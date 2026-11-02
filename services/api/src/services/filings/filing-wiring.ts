import type { JobHandler } from "@civfix/seams"
import type { FastifyBaseLogger } from "fastify"
import type { Container } from "../../di.js"
import { webBaseUrlOf } from "../../lib/base-url.js"
import { makeDrizzleAdminReportRepository } from "../admin/admin-report-repository.drizzle.js"
import { makeDrizzleForwardTemplateRepository } from "../admin/forward-template-repository.drizzle.js"
import { makeDrizzleMailRepository } from "../admin/mail-repository.drizzle.js"
import { makeContainerOutboundMailService } from "../admin/outbound-mail-service.js"
import { makePacketMediaPresigner } from "../media-presign.js"
import { makeContainerReportChatEmitter } from "../report-chat-emitter.js"
import { makeRouteNotificationService } from "../route-notifier.js"
import { makeFilingEmailHandler } from "./filing-email-jobs.js"
import { makeDrizzleFilingRepository } from "./filing-repository.drizzle.js"
import { makeFilingService, type FilingService } from "./filing-service.js"

export function makeContainerFilingService(
  container: Container,
  logger?: FastifyBaseLogger,
): FilingService {
  const sql = container.getDb().sql
  return makeFilingService({
    filings: makeDrizzleFilingRepository(sql),
    reports: makeDrizzleAdminReportRepository(sql, logger !== undefined ? { logger } : {}),
    jobs: container.jobs,
    automaticFiling: container.env.FILING_AUTOMATIC_ENABLED,
    webBaseUrl: webBaseUrlOf(container.env),
    reportChatEmitter: makeContainerReportChatEmitter(container, logger),
    notifications: makeRouteNotificationService(container, logger),
    ...(logger !== undefined ? { logger } : {}),
  })
}

export function makeContainerFilingEmailHandler(
  container: Container,
  logger?: FastifyBaseLogger,
): JobHandler {
  const sql = container.getDb().sql
  const mail = makeDrizzleMailRepository(sql)
  return makeFilingEmailHandler({
    filings: makeDrizzleFilingRepository(sql),
    reports: makeDrizzleAdminReportRepository(sql, logger !== undefined ? { logger } : {}),
    mail,
    outboundMail: makeContainerOutboundMailService(
      container,
      logger !== undefined ? { repo: mail, logger } : { repo: mail },
    ),
    storage: container.storage,
    presignPacketMedia: makePacketMediaPresigner(container.storage),
    forwardTemplates: makeDrizzleForwardTemplateRepository(sql),
    filingService: makeContainerFilingService(container, logger),
    logger: logger ?? console,
  })
}
