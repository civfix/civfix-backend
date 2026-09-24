// PgBossJobs.start() creates the queue (API_QUEUE_NAMES) before this work() call, so work() never races a
// missing queue. The handler is idempotent (ON CONFLICT (geoid) WHERE status <> 'done') and treats an
// unknown or already-onboarded geoid as a no-op, so a retry-on-throw is safe.

import type { Container } from "../../di.js"
import {
  JURISDICTION_DISCOVERY_JOB,
  type JurisdictionDiscoveryJob,
} from "../../services/jurisdiction-service.js"
import {
  hasUsableRoutingContact,
  makeDrizzleDiscoveryRepository,
} from "./discovery-repository.drizzle.js"

export async function registerDiscoveryJobs(container: Container): Promise<void> {
  await container.jobs.work(JURISDICTION_DISCOVERY_JOB, async (job) => {
    const data = (job.data ?? {}) as Partial<JurisdictionDiscoveryJob>
    const geoid = typeof data.geoid === "string" ? data.geoid : ""
    if (geoid === "") return

    const sql = container.getDb().sql

    // A contact may have been saved between the enqueue and this run. Only a contact that has not bounced
    // counts: the bounce handler enqueues this job for the geoid whose contact it just marked.
    if (await hasUsableRoutingContact(sql, geoid)) return

    const repo = makeDrizzleDiscoveryRepository(sql)
    await repo.materializeDiscoveryTask({
      geoid,
      ...(data.population !== undefined ? { population: data.population } : {}),
    })
  })
}
