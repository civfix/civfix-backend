import { describe, it, expect } from "vitest"
import { FakeJobs } from "@civfix/shared/fakes"
import { registerDiscoveryJobs } from "../../src/services/admin/discovery-jobs.js"
import { JURISDICTION_DISCOVERY_JOB } from "../../src/lib/queue-names.js"
import type { Container } from "../../src/di.js"
import { makeFakeSql, type SqlHandler } from "../helpers/fake-sql.js"

/**
 * The jurisdiction-discovery worker skips a geoid that became routable meanwhile (a race), else
 * materializes ONE open discovery task per geoid (idempotent ON CONFLICT). FakeJobs runs a `work()`
 * handler synchronously inside `enqueue()`, so enqueuing drives the handler against the scripted fake `sql`.
 */

function harness(sqlHandlers: SqlHandler[]) {
  const jobs = new FakeJobs()
  const db = makeFakeSql(sqlHandlers)
  const container = { jobs, getDb: () => ({ sql: db.sql }) } as unknown as Container
  return { jobs, db, container }
}

describe("registerDiscoveryJobs", () => {
  it("materializes a discovery task row when the geoid has no contact", async () => {
    const geoid = "0644000"
    const { jobs, db, container } = harness([
      { match: /SELECT\s+EXISTS[\s\S]*has_contact/i, rows: [{ has_contact: false }] },
      { match: /INSERT\s+INTO\s+jurisdiction_discovery_tasks/i, rows: [{ id: "task-1" }] },
    ])
    await registerDiscoveryJobs(container)
    await container.jobs.enqueue(JURISDICTION_DISCOVERY_JOB, { geoid, population: 4000000 })

    expect(jobs.jobsFor(JURISDICTION_DISCOVERY_JOB)[0]?.state).toBe("completed")
    const insert = db.statements.find((s) =>
      /INSERT\s+INTO\s+jurisdiction_discovery_tasks/i.test(s.sql),
    )
    expect(insert).toBeDefined()
    expect(insert?.values).toContain(geoid)
    // The payload's population override is bound (COALESCE($population, j.population)).
    expect(insert?.values).toContain(4000000)
  })

  it("is a NO-OP on conflict: an already-materialized geoid inserts no second task", async () => {
    const geoid = "0644000"
    let inserts = 0
    const { container, db } = harness([
      { match: /SELECT\s+EXISTS[\s\S]*has_contact/i, rows: [{ has_contact: false }] },
      {
        // Emulate the partial UNIQUE (geoid) WHERE status <> 'done': the first INSERT returns an id, a
        // second for the same geoid hits ON CONFLICT DO NOTHING and RETURNS nothing.
        match: /INSERT\s+INTO\s+jurisdiction_discovery_tasks/i,
        rows: () => (inserts++ === 0 ? [{ id: "task-1" }] : []),
      },
    ])
    await registerDiscoveryJobs(container)
    await container.jobs.enqueue(JURISDICTION_DISCOVERY_JOB, { geoid })
    await container.jobs.enqueue(JURISDICTION_DISCOVERY_JOB, { geoid })

    expect(inserts).toBe(2)
    const insertStmts = db.statements.filter((s) =>
      /INSERT\s+INTO\s+jurisdiction_discovery_tasks/i.test(s.sql),
    )
    expect(insertStmts).toHaveLength(2) // both attempted; the DB (not the worker) enforces dedup.
  })

  it("skips materialization when the geoid is already routable (raced onboarding)", async () => {
    const { container, db } = harness([
      { match: /SELECT\s+EXISTS[\s\S]*has_contact/i, rows: [{ has_contact: true }] },
    ])
    await registerDiscoveryJobs(container)
    await container.jobs.enqueue(JURISDICTION_DISCOVERY_JOB, { geoid: "0644000" })

    expect(db.statements.some((s) => /SELECT\s+EXISTS[\s\S]*has_contact/i.test(s.sql))).toBe(true)
    expect(
      db.statements.some((s) => /INSERT\s+INTO\s+jurisdiction_discovery_tasks/i.test(s.sql)),
    ).toBe(false)
  })

  it("does not count a bounced contact as routable, so a bounce-triggered run materializes the task", async () => {
    const { container, db } = harness([
      { match: /SELECT\s+EXISTS[\s\S]*has_contact/i, rows: [{ has_contact: false }] },
      { match: /INSERT\s+INTO\s+jurisdiction_discovery_tasks/i, rows: [{ id: "task-1" }] },
    ])
    await registerDiscoveryJobs(container)
    await container.jobs.enqueue(JURISDICTION_DISCOVERY_JOB, { geoid: "0644000" })

    const probe = db.statements.find((s) => /has_contact/i.test(s.sql))?.sql ?? ""
    const flat = probe.replace(/\s+/g, " ")
    expect(flat).toMatch(
      /FROM jurisdiction_contacts jc WHERE jc\.geoid = \? AND jc\.email IS NOT NULL AND jc\.email <> '' AND jc\.bounced_at IS NULL/,
    )
    expect(flat).toMatch(/FROM unnest\(j\.contact_emails\) AS e WHERE e <> '' AND NOT EXISTS/)
    expect(flat).toMatch(
      /me\.type = 'bounced' AND lower\(me\.meta->>'failedRecipient'\) = lower\(e\)/,
    )
  })

  it("is a no-op for a malformed payload with no geoid (no DB touched)", async () => {
    const { container, db } = harness([])
    await registerDiscoveryJobs(container)
    await container.jobs.enqueue(JURISDICTION_DISCOVERY_JOB, {})
    expect(db.statements).toHaveLength(0)
  })
})
