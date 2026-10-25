import type { FastifyBaseLogger } from "fastify"
import type { Container } from "../../di.js"
import { webBaseUrlOf } from "../../lib/base-url.js"
import { makeDrizzleAdminReportRepository } from "../admin/admin-report-repository.drizzle.js"
import { makeContainerReportChatEmitter } from "../report-chat-emitter.js"
import { makeRouteNotificationService } from "../route-notifier.js"
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
