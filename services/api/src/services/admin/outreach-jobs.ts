import type { Container } from "../../di.js"
import { writeAudit } from "./audit.js"
import { OUTREACH_DIGEST_JOB } from "./jurisdiction-contacts-types.js"
import { makeDrizzleMailRepository } from "./mail-repository.drizzle.js"
import {
  makeContainerOutboundMailService,
  type OutboundMailLogger,
} from "./outbound-mail-service.js"
import { makeDrizzleOutreachRepository } from "./outreach-repository.drizzle.js"
import {
  makeOutreachService,
  type OutreachRunResult,
  type OutreachService,
} from "./outreach-service.js"

export async function registerOutreachJobs(
  container: Container,
  logger?: OutboundMailLogger,
): Promise<void> {
  const service = makeOutreachServiceFromContainer(container, logger)

  if (container.env.OUTREACH_DIGEST_ENABLED) {
    await container.jobs.schedule(OUTREACH_DIGEST_JOB, container.env.OUTREACH_DIGEST_CRON)
  }
  await container.jobs.work(OUTREACH_DIGEST_JOB, async (job) => {
    if (!container.env.OUTREACH_DIGEST_ENABLED) return
    const geoid = extractGeoid(job.data)
    if (geoid !== null) {
      await auditSent(container, [await service.runForGeoid(geoid)])
      return
    }
    const results = await service.runSweep()
    await auditSent(container, results)
    if (results.length >= service.sweepBatchSize && results.some((r) => r.sent)) {
      await container.jobs.enqueue(OUTREACH_DIGEST_JOB, {})
    }
  })
}

function makeOutreachServiceFromContainer(
  container: Container,
  logger: OutboundMailLogger | undefined,
): OutreachService {
  const sql = container.getDb().sql
  const mailRepo = makeDrizzleMailRepository(sql)
  const outboundMail = makeContainerOutboundMailService(container, {
    repo: mailRepo,
    ...(logger !== undefined ? { logger } : {}),
  })
  return makeOutreachService({
    outreachRepo: makeDrizzleOutreachRepository(sql),
    mailRepo,
    outboundMail,
    throttleDays: container.env.OUTREACH_THROTTLE_DAYS,
    ...(logger !== undefined ? { logger } : {}),
  })
}

function extractGeoid(data: unknown): string | null {
  if (data && typeof data === "object") {
    const value = (data as { geoid?: unknown }).geoid
    if (typeof value === "string" && value.length > 0) return value
  }
  return null
}

async function auditSent(container: Container, results: OutreachRunResult[]): Promise<void> {
  const sql = container.getDb().sql
  for (const result of results) {
    if (!result.sent) continue
    await writeAudit(sql, {
      actorId: null,
      action: "outreach.digest_sent",
      target: `jurisdiction:${result.geoid}`,
      meta: {
        geoid: result.geoid,
        reportCount: result.reportCount,
        ...(result.threadId !== undefined ? { threadId: result.threadId } : {}),
      },
    })
  }
}
