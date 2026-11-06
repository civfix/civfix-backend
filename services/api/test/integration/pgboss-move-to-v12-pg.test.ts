/**
 * The pg-boss 10 to 12 move script against real Postgres. The old side is a minimal fixture of pg-boss
 * 10's `pgboss.job` (schema version 24: its columns and its job_state enum, nothing else), so the test
 * needs no pg-boss 10; the new side is the real pgboss_v12 that PgBossJobs.start() creates. The cases run
 * in order: the two without pgboss_v12 first, then pg-boss 12 is booted once for the rest.
 */

import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { PgBossJobs } from "../../src/adapters/jobs.pgboss.js"
import { movePgBossJobsToV12, type PgBossMoveResult } from "../../src/db/pgboss-move-to-v12.js"
import { PGBOSS_SCHEMA } from "../../src/lib/queue-names.js"

const pg = await withPg()

const CHECKS = "media.checks"

interface OldJob {
  id?: string
  name?: string
  state: "created" | "retry" | "active" | "completed"
  data?: Record<string, string | boolean>
  priority?: number
  retryLimit?: number
  retryCount?: number
  retryDelay?: number
  retryBackoff?: boolean
  singletonKey?: string | null
  startAfter?: Date
  expireIn?: string
}

describe.skipIf(!pg)("pg-boss move to pgboss_v12 (integration)", () => {
  let h: PgHarness

  async function createOldSchema(): Promise<void> {
    await h.sql.unsafe(`
      CREATE SCHEMA pgboss;
      CREATE TYPE pgboss.job_state AS ENUM ('created', 'retry', 'active', 'completed', 'cancelled', 'failed');
      CREATE TABLE pgboss.job (
        id uuid NOT NULL DEFAULT gen_random_uuid(),
        name text NOT NULL,
        priority integer NOT NULL DEFAULT 0,
        data jsonb,
        state pgboss.job_state NOT NULL DEFAULT 'created',
        retry_limit integer NOT NULL DEFAULT 2,
        retry_count integer NOT NULL DEFAULT 0,
        retry_delay integer NOT NULL DEFAULT 0,
        retry_backoff boolean NOT NULL DEFAULT false,
        start_after timestamptz NOT NULL DEFAULT now(),
        started_on timestamptz,
        singleton_key text,
        singleton_on timestamp without time zone,
        expire_in interval NOT NULL DEFAULT interval '15 minutes',
        created_on timestamptz NOT NULL DEFAULT now(),
        completed_on timestamptz,
        keep_until timestamptz NOT NULL DEFAULT now() + interval '14 days',
        output jsonb,
        dead_letter text,
        policy text,
        PRIMARY KEY (name, id)
      );
    `)
  }

  async function oldJob(job: OldJob): Promise<string> {
    const id = job.id ?? randomUUID()
    await h.sql`
      INSERT INTO pgboss.job (
        id, name, state, data, priority, retry_limit, retry_count, retry_delay, retry_backoff,
        singleton_key, start_after, expire_in, started_on, completed_on, created_on
      )
      VALUES (
        ${id}, ${job.name ?? CHECKS}, ${job.state}::pgboss.job_state, ${h.sql.json(job.data ?? { id })},
        ${job.priority ?? 0}, ${job.retryLimit ?? 2}, ${job.retryCount ?? 0}, ${job.retryDelay ?? 0},
        ${job.retryBackoff ?? false}, ${job.singletonKey ?? null}, ${job.startAfter ?? new Date()},
        ${job.expireIn ?? "15 minutes"}::interval,
        ${job.state === "created" ? null : new Date(Date.now() - 60 * 1000)},
        ${job.state === "completed" ? new Date() : null},
        now() - interval '1 hour'
      )
    `
    return id
  }

  async function oldStates(): Promise<Record<string, string>> {
    const rows = await h.sql<{ id: string; state: string }[]>`SELECT id, state FROM pgboss.job`
    return Object.fromEntries(rows.map((r) => [r.id, r.state]))
  }

  async function targetIds(): Promise<string[]> {
    const rows = await h.sql<{ id: string }[]>`SELECT id FROM pgboss_v12.job ORDER BY id`
    return rows.map((r) => r.id)
  }

  function counts(result: PgBossMoveResult, name: string) {
    return result.queues.find((q) => q.name === name)
  }

  /** A, B, C and D of T23: one media.checks job in each of created, retry, active and completed. */
  async function fourJobs(): Promise<{ a: string; b: string; c: string; d: string }> {
    return {
      a: await oldJob({
        state: "created",
        expireIn: "20 minutes",
        singletonKey: "k-a",
        priority: 3,
        retryLimit: 5,
        retryDelay: 7,
        retryBackoff: true,
      }),
      b: await oldJob({
        state: "retry",
        retryCount: 1,
        startAfter: new Date(Date.now() + 60 * 60 * 1000),
      }),
      c: await oldJob({ state: "active" }),
      d: await oldJob({ state: "completed" }),
    }
  }

  beforeAll(() => {
    h = pg as PgHarness
  })

  afterAll(async () => {
    await h?.teardown()
  })

  describe("before pg-boss 12 has run", () => {
    it("T31: with no pgboss_v12 every waiting job is skipped for want of a queue and nothing is created", async () => {
      await createOldSchema()
      const a = await oldJob({ state: "created" })

      const result = await movePgBossJobsToV12(h.sql, { apply: true })

      expect(result).toEqual({
        oldSchema: true,
        queues: [{ name: CHECKS, moved: 0, skippedExisting: 0, skippedNoQueue: 1 }],
      })
      expect(await oldStates()).toEqual({ [a]: "created" })
      const [schema] = await h.sql<{ missing: boolean }[]>`
        SELECT to_regnamespace('pgboss_v12') IS NULL AS missing
      `
      expect(schema!.missing).toBe(true)
    })
  })

  describe("with pgboss_v12 booted", () => {
    beforeAll(async () => {
      const jobs = new PgBossJobs({ connectionString: h.uri })
      await jobs.start()
      await jobs.stop()
    })

    beforeEach(async () => {
      await h.sql`DROP TRIGGER IF EXISTS refuse_update ON pgboss.job`
      await h.sql`DELETE FROM pgboss.job`
      await h.sql`DELETE FROM pgboss_v12.job`
    })

    it("T23: a dry run counts the created and retry jobs and changes nothing", async () => {
      const { a, b, c, d } = await fourJobs()

      const result = await movePgBossJobsToV12(h.sql, { apply: false })

      expect(counts(result, CHECKS)).toEqual({
        name: CHECKS,
        moved: 2,
        skippedExisting: 0,
        skippedNoQueue: 0,
      })
      expect(await targetIds()).toEqual([])
      expect(await oldStates()).toEqual({
        [a]: "created",
        [b]: "retry",
        [c]: "active",
        [d]: "completed",
      })
    })

    it("T24: --apply copies the created and retry jobs column for column and cancels their old rows", async () => {
      const { a, b, c, d } = await fourJobs()
      const columns = h.sql`
        name, id, priority, data, state::text AS state, retry_limit, retry_count, retry_delay,
        retry_backoff, singleton_key, singleton_on, start_after, started_on, created_on, dead_letter
      `
      const before = await h.sql`
        SELECT ${columns} FROM pgboss.job WHERE id IN (${a}, ${b}) ORDER BY id
      `

      const result = await movePgBossJobsToV12(h.sql, { apply: true })

      expect(counts(result, CHECKS)).toMatchObject({ moved: 2 })
      const after = await h.sql`
        SELECT ${columns} FROM pgboss_v12.job WHERE id IN (${a}, ${b}) ORDER BY id
      `
      expect(after).toEqual(before)
      const moved = await h.sql<{ id: string; expire_seconds: number; policy: string }[]>`
        SELECT id, expire_seconds, policy FROM pgboss_v12.job ORDER BY id
      `
      expect(moved.map((r) => r.policy)).toEqual(["short", "short"])
      expect(moved.find((r) => r.id === a)?.expire_seconds).toBe(1200)
      expect(await oldStates()).toEqual({
        [a]: "cancelled",
        [b]: "cancelled",
        [c]: "active",
        [d]: "completed",
      })
    })

    it("T33: pg-boss 12 counts the next run of a moved retry job against its retries", async () => {
      const e = await oldJob({ state: "retry", retryCount: 1, retryLimit: 2 })
      await movePgBossJobsToV12(h.sql, { apply: true })
      const { PgBoss } = await import("pg-boss")
      const boss = new PgBoss({ connectionString: h.uri, schema: PGBOSS_SCHEMA })
      const errors: Error[] = []
      boss.on("error", (err: Error) => errors.push(err))
      await boss.start()
      try {
        const fetched = await boss.fetch(CHECKS)
        expect(fetched.map((job) => job.id)).toEqual([e])
      } finally {
        await boss.stop({ graceful: false })
      }

      const [row] = await h.sql<{ state: string; retry_count: number }[]>`
        SELECT state::text AS state, retry_count FROM pgboss_v12.job WHERE id = ${e}
      `
      expect(row).toEqual({ state: "active", retry_count: 2 })
      expect(errors).toEqual([])
    })

    it("T25: when cancelling the old rows fails, nothing is copied either", async () => {
      const { a, b, c, d } = await fourJobs()
      await h.sql.unsafe(`
        CREATE OR REPLACE FUNCTION pgboss.refuse_update() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'update refused'; END $$;
        CREATE TRIGGER refuse_update BEFORE UPDATE ON pgboss.job
          FOR EACH ROW EXECUTE FUNCTION pgboss.refuse_update();
      `)

      await expect(movePgBossJobsToV12(h.sql, { apply: true })).rejects.toThrow(/update refused/)

      expect(await targetIds()).toEqual([])
      expect(await oldStates()).toEqual({
        [a]: "created",
        [b]: "retry",
        [c]: "active",
        [d]: "completed",
      })
    })

    it("T26: a second --apply moves nothing", async () => {
      await fourJobs()
      await movePgBossJobsToV12(h.sql, { apply: true })
      const [before] = await h.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM pgboss_v12.job`

      const second = await movePgBossJobsToV12(h.sql, { apply: true })

      for (const q of second.queues) {
        expect(q, q.name).toMatchObject({ moved: 0, skippedExisting: 0 })
      }
      const [after] = await h.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM pgboss_v12.job`
      expect(after!.n).toBe(before!.n)
    })

    it("T27: a job whose id is already in pgboss_v12 is skipped and its old row cancelled", async () => {
      const x = randomUUID()
      await h.sql`
        INSERT INTO pgboss_v12.job (name, id, data, policy)
        VALUES (${CHECKS}, ${x}, ${h.sql.json({ kept: true })}, 'short')
      `
      await oldJob({ id: x, state: "created", data: { kept: false } })

      const result = await movePgBossJobsToV12(h.sql, { apply: true })

      expect(counts(result, CHECKS)).toEqual({
        name: CHECKS,
        moved: 0,
        skippedExisting: 1,
        skippedNoQueue: 0,
      })
      expect(await oldStates()).toEqual({ [x]: "cancelled" })
      const [target] = await h.sql<{ data: object }[]>`
        SELECT data FROM pgboss_v12.job WHERE name = ${CHECKS} AND id = ${x}
      `
      expect(target!.data).toEqual({ kept: true })
    })

    it("T28: a short job whose singletonKey is already waiting in pgboss_v12 is skipped and its old row cancelled", async () => {
      const original = randomUUID()
      await h.sql`
        INSERT INTO pgboss_v12.job (name, id, singleton_key, policy)
        VALUES (${CHECKS}, ${original}, 'k-dup', 'short')
      `
      const f = await oldJob({ state: "created", singletonKey: "k-dup" })

      const result = await movePgBossJobsToV12(h.sql, { apply: true })

      expect(counts(result, CHECKS)).toEqual({
        name: CHECKS,
        moved: 0,
        skippedExisting: 1,
        skippedNoQueue: 0,
      })
      expect(await oldStates()).toEqual({ [f]: "cancelled" })
      const waiting = await h.sql<{ id: string }[]>`
        SELECT id FROM pgboss_v12.job
        WHERE name = ${CHECKS} AND state = 'created' AND singleton_key = 'k-dup'
      `
      expect(waiting.map((r) => r.id)).toEqual([original])
    })

    it("T29: a job on a queue pgboss_v12 does not have is counted and left as it is", async () => {
      const g = await oldJob({ name: "retired.queue", state: "created" })

      const result = await movePgBossJobsToV12(h.sql, { apply: true })

      expect(counts(result, "retired.queue")).toEqual({
        name: "retired.queue",
        moved: 0,
        skippedExisting: 0,
        skippedNoQueue: 1,
      })
      expect(await oldStates()).toEqual({ [g]: "created" })
      expect(await targetIds()).toEqual([])
    })

    it("T30: with no pgboss schema both a dry run and --apply do nothing", async () => {
      const kept = randomUUID()
      await h.sql`INSERT INTO pgboss_v12.job (name, id, policy) VALUES (${CHECKS}, ${kept}, 'short')`
      await h.sql`DROP SCHEMA pgboss CASCADE`
      const [schema] = await h.sql<{ missing: boolean }[]>`
        SELECT to_regnamespace('pgboss') IS NULL AS missing
      `
      expect(schema!.missing).toBe(true)

      for (const apply of [false, true]) {
        expect(await movePgBossJobsToV12(h.sql, { apply })).toEqual({
          oldSchema: false,
          queues: [],
        })
      }
      expect(await targetIds()).toEqual([kept])
    })
  })
})
