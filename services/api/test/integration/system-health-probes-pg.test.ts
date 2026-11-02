import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { makeSystemHealthProbes } from "../../src/services/admin/system-health-probes.js"
import { PgBossJobs } from "../../src/adapters/jobs.pgboss.js"

const pg = await withPg()

describe.skipIf(!pg)("system health probes (Postgres)", () => {
  let h: PgHarness

  beforeAll(() => {
    h = pg as PgHarness
  })

  afterAll(async () => {
    await h?.teardown()
  })

  it("T44: the email probe counts only mail sent in the last 7 days", async () => {
    const probe = makeSystemHealthProbes({ getSql: () => h.sql }).ociEmail
    if (probe === undefined) throw new Error("no email probe with a database")
    await h.sql`TRUNCATE mail_events`
    await h.sql`
      INSERT INTO mail_events (type, created_at)
      VALUES
        ('sent', now() - interval '1 hour'),
        ('sent', now() - interval '3 days'),
        ('sent', now() - interval '6 days'),
        ('delivered', now() - interval '1 hour'),
        ('delivered', now() - interval '2 days'),
        ('sent', now() - interval '8 days')
    `
    expect(await probe()).toEqual({ val: "3 sent in the last 7 days", status: "ok" })

    await h.sql`TRUNCATE mail_events`
    expect(await probe()).toEqual({ val: "0 sent in the last 7 days", status: "ok" })
  })

  it("GH297-T17: before pg-boss 12 has created its schema the media worker tile says not provisioned", async () => {
    const probe = makeSystemHealthProbes({ getSql: () => h.sql }).mediaWorker
    if (probe === undefined) throw new Error("no media worker probe with a database")
    const [schema] = await h.sql<{ missing: boolean }[]>`
      SELECT to_regnamespace('pgboss_v12') IS NULL AS missing
    `
    expect(schema!.missing).toBe(true)
    expect(await probe()).toEqual({ val: "Queue not provisioned", status: "not_deployed" })
  })

  it("GH297-T16: the media worker probe counts the media queues' created, active and retry jobs in pgboss_v12", async () => {
    const jobs = new PgBossJobs({ connectionString: h.uri })
    await jobs.start()
    await jobs.stop()
    const probe = makeSystemHealthProbes({ getSql: () => h.sql }).mediaWorker
    if (probe === undefined) throw new Error("no media worker probe with a database")
    const states = [
      "created",
      "created",
      "active",
      "retry",
      "completed",
      "completed",
      "completed",
      "failed",
    ]
    for (const state of states) {
      await h.sql`
        INSERT INTO pgboss_v12.job (name, state, completed_on)
        VALUES (
          'media.checks',
          ${state}::pgboss_v12.job_state,
          ${state === "completed" || state === "failed" ? new Date() : null}
        )
      `
    }
    await h.sql`INSERT INTO pgboss_v12.job (name, state) VALUES ('data.export', 'created')`
    expect(await probe()).toEqual({ val: "depth 4", status: "ok" })
  })
})
