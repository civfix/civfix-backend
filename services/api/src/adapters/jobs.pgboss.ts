/**
 * REAL Jobs adapter backed by pg-boss (Postgres-backed queue + cron scheduler).
 *
 * This is the API process's ENQUEUE side of the jobs seam: the API sends jobs (media.checks at media
 * finalize, jurisdiction.discovery when a point lands outside known coverage) and the separate
 * media-worker process consumes them. The worker has its own pg-boss handle (services/media-worker/
 * src/jobs.ts) for the WORKER side (work/schedule/createQueue); this adapter mirrors that wiring for
 * the API and is the ONLY place the API imports pg-boss.
 *
 * Seam rule: pg-boss may ONLY be imported in this file (and in the media-worker's own adapter). The
 * import is lazy (await import("pg-boss")) so merely constructing the container in all-fakes mode never
 * pulls pg-boss in.
 *
 * pg-boss v10 notes:
 *   - queues must EXIST before send(), so start() calls createQueue for every queue the API enqueues.
 *   - send(name, data, options) returns the job id (or null when deduped by singletonKey).
 *   - complete/fail in v10 are (name, id)-keyed; the shared Jobs.complete/fail are name-agnostic and the
 *     API never calls them (it only enqueues), so they are safe no-ops here (mirrors the worker).
 */

import type PgBoss from "pg-boss"
import type { Jobs, EnqueueOptions, JobHandler } from "@civfix/shared/interfaces"

export interface PgBossJobsConfig {
  /** Postgres connection string for the pg-boss schema (usually the same as DATABASE_URL). */
  connectionString: string
  /** Optional schema name for pg-boss tables (default pg-boss "pgboss"). */
  schema?: string
}

/**
 * Queues the API enqueues onto. They are created (idempotently) in start() so a send() never races a
 * missing queue. The worker creates the same names on its side; createQueue is idempotent so both
 * processes calling it is safe. Keep this list in sync with every name the API passes to enqueue().
 */
export const API_QUEUE_NAMES = [
  "media.checks",
  "jurisdiction.discovery",
  // Phase 2 outreach digest: enqueued by discovery "Save & route" (singletonKey=geoid) and scheduled as
  // a cron by registerOutreachJobs. Created here so both the enqueue + the schedule/work find the queue.
  "outreach.digest",
] as const

/** Map the shared EnqueueOptions onto pg-boss SendOptions (only set the fields that are provided). */
function toSendOptions(opts?: EnqueueOptions): PgBoss.SendOptions {
  const out: PgBoss.SendOptions = {}
  if (opts?.singletonKey !== undefined) out.singletonKey = opts.singletonKey
  if (opts?.startAfter !== undefined) out.startAfter = opts.startAfter
  if (opts?.retryLimit !== undefined) out.retryLimit = opts.retryLimit
  return out
}

export class PgBossJobs implements Jobs {
  private readonly config: PgBossJobsConfig
  private boss: PgBoss | undefined

  constructor(config: PgBossJobsConfig) {
    this.config = config
  }

  /**
   * Open the pg-boss connection, start it, and ensure every queue the API enqueues exists. Idempotent:
   * a second call while already started is a no-op (the server start() guards on this too).
   */
  async start(): Promise<void> {
    if (this.boss) return
    const { default: PgBossCtor } = await import("pg-boss")
    const boss = new PgBossCtor({
      connectionString: this.config.connectionString,
      ...(this.config.schema !== undefined ? { schema: this.config.schema } : {}),
    })
    // Surface internal errors loudly instead of letting them crash the process.
    boss.on("error", (err: Error) => console.error("pg-boss error:", err))
    await boss.start()
    // pg-boss v10 requires a queue to exist before send(); create the API's queues up front so the hot
    // paths (finalize -> media.checks, report create -> jurisdiction.discovery) never 500 on a missing
    // queue. Every API queue is enqueued with a singletonKey for dedup, and in v10 that dedup ONLY
    // happens under a queue policy — the default "standard" policy does NOT dedup. "short" allows at most
    // one job per (queue, singletonKey) in the `created` state, which is exactly "don't pile up duplicate
    // pending work". createQueue is a no-op if the queue already exists, so updateQueue is what actually
    // brings a previously-created (e.g. default-policy) queue to the right policy. Both are idempotent.
    for (const name of API_QUEUE_NAMES) {
      await boss.createQueue(name, { name, policy: "short" })
      await boss.updateQueue(name, { name, policy: "short" })
    }
    this.boss = boss
  }

  /** Stop the underlying pg-boss instance gracefully. Safe to call when never started. */
  async stop(): Promise<void> {
    if (!this.boss) return
    // Graceful: let any in-flight operations finish, then close. wait:true resolves after fully stopped.
    await this.boss.stop({ graceful: true, wait: true })
    this.boss = undefined
  }

  private requireBoss(): PgBoss {
    if (!this.boss) throw new Error("pg-boss not started (call jobs.start() before enqueue)")
    return this.boss
  }

  async enqueue(name: string, data: unknown, opts?: EnqueueOptions): Promise<string> {
    const id = await this.requireBoss().send(name, data as object, toSendOptions(opts))
    // send() returns null when a singletonKey dedupes the job to an already-queued one; the effect
    // (a job for that key is queued) still holds, so return "" rather than throwing.
    return id ?? ""
  }

  async schedule(name: string, cron: string, data?: unknown): Promise<void> {
    await this.requireBoss().schedule(name, cron, (data as object) ?? {})
  }

  async work(name: string, handler: JobHandler): Promise<void> {
    // The API is the enqueue side and does not normally register workers, but the shared Jobs surface
    // includes work(); wire it through faithfully so the seam is complete. pg-boss v10 delivers an
    // array of jobs to the callback; adapt to the single-job shared JobHandler by iterating.
    await this.requireBoss().work(name, async (jobs: PgBoss.Job[]) => {
      await Promise.all(jobs.map((j) => handler({ id: j.id, data: j.data })))
    })
  }

  async complete(jobId: string): Promise<void> {
    // pg-boss v10 completes by (name, id); the shared Jobs.complete is name-agnostic and the API never
    // calls it (handlers that resolve complete implicitly), so provide a safe no-op rather than guessing
    // a queue name (mirrors the worker adapter).
    void jobId
    return Promise.resolve()
  }

  async fail(jobId: string, _err?: unknown): Promise<void> {
    void jobId
    return Promise.resolve()
  }
}
