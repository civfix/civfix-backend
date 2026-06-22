/**
 * Registers the `jurisdiction.discovery` pg-boss worker that materializes a discovery TASK row so an
 * un-onboarded jurisdiction surfaces in the operator's queue.
 *
 * The queue is created by PgBossJobs.start() (API_QUEUE_NAMES), which runs BEFORE this work() call, so
 * work() never races a missing queue. The handler is idempotent (ON CONFLICT (geoid) WHERE status <>
 * 'done') and never throws on a benign miss (unknown geoid / already-onboarded) — those are no-ops, so a
 * retry-on-throw is safe.
 */

import type { Container } from "../../di.js"
import {
  JURISDICTION_DISCOVERY_JOB,
  type JurisdictionDiscoveryJob,
} from "../../services/jurisdiction-service.js"
import { makeDrizzleDiscoveryRepository } from "./discovery-repository.drizzle.js"

export async function registerDiscoveryJobs(container: Container): Promise<void> {
  await container.jobs.work(JURISDICTION_DISCOVERY_JOB, async (job) => {
    const data = (job.data ?? {}) as Partial<JurisdictionDiscoveryJob>
    const geoid = typeof data.geoid === "string" ? data.geoid : ""
    if (geoid === "") return // Malformed payload: nothing to discover.

    const sql = container.getDb().sql

    // Raced-onboarding skip: a contact may have been saved between the enqueue and this run, in which case
    // the jurisdiction is already routable and there is nothing to discover. Cheap EXISTS probe over the
    // per-category routing model + the legacy contact_emails[] (mirrors loadHealth's has_routing_contact).
    const contactRows = await sql<{ has_contact: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM jurisdiction_contacts jc
        WHERE jc.geoid = ${geoid} AND jc.email IS NOT NULL AND jc.email <> ''
      ) OR EXISTS (
        SELECT 1 FROM jurisdictions j
        WHERE j.geoid = ${geoid}
          AND j.contact_emails IS NOT NULL AND array_length(j.contact_emails, 1) > 0
      ) AS has_contact
    `
    if (contactRows[0]?.has_contact === true) return

    // Materialize the open task (idempotent per geoid). population from the payload overrides the
    // jurisdiction's own when present; the repo wires a newest waiting sample report for the detail map.
    const repo = makeDrizzleDiscoveryRepository(sql)
    await repo.materializeDiscoveryTask({
      geoid,
      ...(data.population !== undefined ? { population: data.population } : {}),
    })
  })
}
