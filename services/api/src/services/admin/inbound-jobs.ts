import type { Container } from "../../di.js"
import { runInboundSweep } from "./inbound-sweep.js"
import { FILING_CITY_UPDATE_JOB, INBOUND_SWEEP_JOB } from "../../lib/queue-names.js"
import { makeDrizzleAdminReportRepository } from "./admin-report-repository.drizzle.js"
import { makeContainerReportChatEmitter } from "../report-chat-emitter.js"
import { makeRouteNotificationService } from "../route-notifier.js"
import { makeApplyCityUpdate } from "../filings/city-update-jobs.js"
import { makeDrizzleFilingIngestSql } from "../filings/filing-ingest-sql.drizzle.js"

export async function registerInboundJobs(container: Container): Promise<void> {
  await container.jobs.schedule(INBOUND_SWEEP_JOB, container.env.INBOUND_SWEEP_CRON)
  await container.jobs.work(INBOUND_SWEEP_JOB, async () => {
    const result = await runInboundSweep(container, {
      deps: {
        logger: {
          warn: (obj, msg) => console.warn(msg ?? INBOUND_SWEEP_JOB, obj),
          error: (obj, msg) => console.error(msg ?? INBOUND_SWEEP_JOB, obj),
        },
      },
    })
    if (result.listError !== undefined) {
      console.error(
        `inbound.sweep: R2 LIST of '${container.env.R2_INBOUND_BUCKET ?? container.env.R2_BUCKET}' failed ` +
          `(grant the R2 token Object Read & Write on that bucket): ${result.listError}`,
      )
    } else if (
      result.processed > 0 ||
      result.errors > 0 ||
      result.parked > 0 ||
      result.effectsRedriven > 0 ||
      result.effectsErrors > 0
    ) {
      console.info(
        `inbound.sweep: scanned=${result.scanned} processed=${result.processed} errors=${result.errors} ` +
          `parked=${result.parked} effectsRedriven=${result.effectsRedriven} effectsErrors=${result.effectsErrors}`,
      )
    }
    if (result.effectsErrors > 0) {
      console.error(
        `inbound.sweep: ${result.effectsErrors} inbound message(s) failed their side effects; ` +
          `their claims were released and the next run re-drives them`,
      )
    }
  })

  const cityUpdateLogger = {
    warn: (obj: unknown, msg?: string) => console.warn(msg ?? FILING_CITY_UPDATE_JOB, obj),
    error: (obj: unknown, msg?: string) => console.error(msg ?? FILING_CITY_UPDATE_JOB, obj),
  }
  await container.jobs.work(FILING_CITY_UPDATE_JOB, async (job) => {
    const sql = container.getDb().sql
    await makeApplyCityUpdate({
      ingest: makeDrizzleFilingIngestSql(sql),
      reports: makeDrizzleAdminReportRepository(sql),
      notifications: makeRouteNotificationService(container, cityUpdateLogger),
      chatEmitter: makeContainerReportChatEmitter(container, cityUpdateLogger),
      logger: cityUpdateLogger,
    })(job.data)
  })
}
