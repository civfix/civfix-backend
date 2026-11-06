/**
 * pg-boss Jobs adapter integration test (Docker-gated). Runs the REAL PgBossJobs against the live
 * Postgres from withPg(): start() creates the pgboss_v12 schema + the API queues, enqueue() actually
 * sends a job, and we read it back out of pgboss_v12.job to prove the round-trip. The worker side, end
 * to end, is in services/media-worker/test/integration/pgboss-v12-pg.test.ts.
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

  it("T11: a media.checks enqueue lands in pgboss_v12.job and a second with the same singletonKey dedups", async () => {
    const data = {
      mediaId: "11111111-1111-1111-1111-111111111111",
      uploadId: "22222222-2222-2222-2222-222222222222",
      r2Key: "uploads/2026/06/x",
      kind: "image" as const,
    }
    const first = await jobs.enqueue("media.checks", data, { singletonKey: data.uploadId })
    expect(first).not.toBe("")
    // The first is still created, so pg-boss returns null under the "short" policy and the adapter maps
    // it to "".
    const second = await jobs.enqueue("media.checks", data, { singletonKey: data.uploadId })
    expect(second).toBe("")

    const rows = await h.sql<{ id: string; data: typeof data }[]>`
      SELECT id, data
      FROM pgboss_v12.job
      WHERE name = 'media.checks' AND state = 'created' AND singleton_key = ${data.uploadId}
    `
    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toBe(first)
    expect(rows[0]!.data).toEqual(data)
  })
})
