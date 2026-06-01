/**
 * pg-boss Jobs adapter integration test (Docker-gated). Runs the REAL PgBossJobs against the live
 * Postgres from withPg(): start() creates the pgboss schema + the API queues, enqueue() actually sends
 * a job, and we read it back off the queue to prove the round-trip. This is the end-to-end proof that
 * the API's enqueue hot paths (media.checks, jurisdiction.discovery) work against real pg-boss, not
 * just the mocked unit test.
 *
 * When Docker is unavailable the whole block SKIPS (describe.skipIf) so the local suite stays green;
 * CI runs it for real.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { PgBossJobs } from "../../src/adapters/jobs.pgboss.js"

const pg = await withPg()

describe.skipIf(!pg)("pg-boss jobs adapter (integration)", () => {
  let h: PgHarness
  let jobs: PgBossJobs

  beforeAll(async () => {
    h = pg as PgHarness
    jobs = new PgBossJobs({ connectionString: h.uri })
    await jobs.start()
  })

  afterAll(async () => {
    await jobs?.stop()
    await h.teardown()
  })

  it("enqueues a media.checks job and it is readable back off the queue", async () => {
    const data = {
      mediaId: "11111111-1111-1111-1111-111111111111",
      uploadId: "22222222-2222-2222-2222-222222222222",
      r2Key: "uploads/2026/06/x",
      kind: "image" as const,
    }
    const id = await jobs.enqueue("media.checks", data, { singletonKey: data.uploadId })
    expect(id).not.toBe("")

    // Read the queued job straight out of the pgboss job table (default schema "pgboss"). It is created
    // (state 'created') and carries our exact payload. Using the raw sql tag avoids depending on a
    // second pg-boss worker instance just to observe the row.
    const rows = await h.sql<{ id: string; name: string; data: typeof data; state: string }[]>`
      SELECT id, name, data, state
      FROM pgboss.job
      WHERE name = 'media.checks' AND id = ${id}
      LIMIT 1
    `
    expect(rows).toHaveLength(1)
    expect(rows[0]!.name).toBe("media.checks")
    expect(rows[0]!.state).toBe("created")
    expect(rows[0]!.data).toEqual(data)
  })

  it("a singletonKey dedupes a second enqueue to the same queued job", async () => {
    const data = { geoid: "0644000" }
    const first = await jobs.enqueue("jurisdiction.discovery", data, { singletonKey: data.geoid })
    expect(first).not.toBe("")
    // Same singletonKey while the first is still queued -> pg-boss returns null, the adapter maps to "".
    const second = await jobs.enqueue("jurisdiction.discovery", data, { singletonKey: data.geoid })
    expect(second).toBe("")

    const rows = await h.sql<{ n: number }[]>`
      SELECT count(*)::int AS n
      FROM pgboss.job
      WHERE name = 'jurisdiction.discovery' AND state = 'created'
    `
    expect(rows[0]!.n).toBe(1)
  })
})
