// PgBossJobs.start() creates the queue (API_QUEUE_NAMES) before this work() call, so work() never races a
// missing queue. The handler is idempotent (ON CONFLICT (geoid) WHERE status <> 'done') and treats an
// unknown or already-onboarded geoid as a no-op, so a retry-on-throw is safe.

import type { Container } from "../../di.js"
import {
  JURISDICTION_DISCOVERY_JOB,
  type JurisdictionDiscoveryJob,
} from "../../services/jurisdiction-service.js"
import { makeDrizzleDiscoveryRepository } from "./discovery-repository.drizzle.js"
import { legacyContactEmailUsable } from "./sql-fragments.js"

export async function registerDiscoveryJobs(container: Container): Promise<void> {
  await container.jobs.work(JURISDICTION_DISCOVERY_JOB, async (job) => {
    const data = (job.data ?? {}) as Partial<JurisdictionDiscoveryJob>
    const geoid = typeof data.geoid === "string" ? data.geoid : ""
    if (geoid === "") return

    const sql = container.getDb().sql

    // A contact may have been saved between the enqueue and this run. Only a contact that has not bounced
    // counts: the bounce handler enqueues this job for the geoid whose contact it just marked.
    const contactRows = await sql<{ has_contact: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM jurisdiction_contacts jc
        WHERE jc.geoid = ${geoid} AND jc.email IS NOT NULL AND jc.email <> ''
          AND jc.bounced_at IS NULL
      ) OR EXISTS (
        SELECT 1 FROM jurisdictions j
        WHERE j.geoid = ${geoid}
          AND EXISTS (
            SELECT 1 FROM unnest(j.contact_emails) AS e
            WHERE e <> ''
              AND ${legacyContactEmailUsable(sql, {
                email: sql`e`,
                geoid: sql`j.geoid`,
                contactUpdatedAt: sql`j.contact_updated_at`,
              })}
          )
      ) AS has_contact
    `
    if (contactRows[0]?.has_contact === true) return

    const repo = makeDrizzleDiscoveryRepository(sql)
    await repo.materializeDiscoveryTask({
      geoid,
      ...(data.population !== undefined ? { population: data.population } : {}),
    })
  })
}
