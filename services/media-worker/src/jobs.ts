/**
 * Jobs seam for the media worker (pg-boss-backed, real or fake).
 *
 * The worker is a separate process from the API and does its own minimal seam wiring rather than
 * importing the API's Fastify DI container. Real-vs-fake is chosen by USE_FAKE_JOBS, mirroring the
 * API's rule (default ON outside production so the worker boots offline with FakeJobs).
 *
 * Seam rule: pg-boss is imported ONLY here (and in the API's jobs.pgboss adapter). The worker bundles
 * its own pg-boss handle because it needs the WORKER side (work/schedule/createQueue), which the API's
 * enqueue-only adapter does not expose.
 *
 * pg-boss v10 notes:
 *   - queues must exist before send/work, so the handle exposes createQueue (idempotent).
 *   - work(name, options, handler) delivers an ARRAY of jobs; we adapt to the shared single-job
 *     JobHandler by iterating, and use batchSize to bound in-flight concurrency.
 */

import type PgBoss from "pg-boss"
import type { Jobs, EnqueueOptions, JobHandler } from "@civfix/shared/interfaces"
import { FakeJobs } from "@civfix/shared/fakes"
import { parseBool } from "./config.js"
import { MediaInfraError } from "./jobs/media-checks.js"

/** Default ON outside production so the worker boots offline. */
function useFakeJobs(source: NodeJS.ProcessEnv = process.env): boolean {
  const isProd = source.NODE_ENV === "production"
  return parseBool(source.USE_FAKE_JOBS, !isProd)
}

/** Options accepted when registering a worker handler (concurrency mapping). */
export interface WorkSettings {
  /** Max jobs delivered + processed per poll (bounds in-flight concurrency). */
  batchSize?: number
  /** Poll interval seconds (pg-boss default ~2s). */
  pollingIntervalSeconds?: number
}

/**
 * Queue-level retry policy (pg-boss v10 createQueue options). Applied to every job on the queue, so it
 * governs how a job whose handler THROWS is retried. This is the knob that makes media.checks' infra
 * throws (MediaInfraError) recover with bounded backoff: pg-boss v10's default retryLimit is 2 (retries
 * are opt-OUT), but we set it explicitly so the value is intentional, not a default we inherit. Set on
 * the WORKER's createQueue (the worker owns the work side); the fake ignores it.
 */
export interface QueueOptions {
  /** Max retries before a job is marked failed for good (pg-boss v10 default is 2; retries are opt-OUT). */
  retryLimit?: number
  /** Exponential backoff between retries (pg-boss spaces them out instead of retrying immediately). */
  retryBackoff?: boolean
  /**
   * pg-boss queue policy. MUST be set explicitly for any queue the worker shares with another creator or
   * relies on singletonKey dedup for: pg-boss `updateQueue` rewrites `policy` to its default ("standard")
   * whenever it is omitted, which would silently CLOBBER a policy a different creator set. The API creates
   * `media.checks` with policy "short" so its `enqueue(..., { singletonKey })` dedups duplicate pending
   * jobs (the partial-unique index only fires under "short"); the worker also creates that queue, so it
   * must pass the SAME "short" or its boot-time updateQueue would break the dedup on boot-order-dependent
   * deploys. The worker likewise enqueues `anon.hold.release` with a singletonKey, so that queue needs it too.
   */
  policy?: PgBoss.Queue["policy"]
}

/** Per-schedule options for a cron (worker extension over Jobs.schedule's data-only signature). */
export interface ScheduleOptions {
  /** Expire (and allow re-delivery) a scheduled job after this many seconds; sized above worst-case run. */
  expireInSeconds?: number
  /** Single-flight key so two fires of the same cron never overlap. */
  singletonKey?: string
}

/** The worker's Jobs handle: the shared Jobs surface plus worker-only lifecycle + queue helpers. */
export interface WorkerJobs extends Jobs {
  start(): Promise<void>
  stop(): Promise<void>
  /**
   * Ensure a queue exists (idempotent). Required by pg-boss v10 before send/work. Optional retry policy
   * is applied to the queue (so a throwing handler retries with bounded backoff rather than failing once).
   */
  createQueue(name: string, options?: QueueOptions): Promise<void>
  /** Register a handler with concurrency/poll settings (worker extension over Jobs.work). */
  workWithSettings(name: string, handler: JobHandler, settings?: WorkSettings): Promise<void>
  /** Schedule a cron, widened over Jobs.schedule with optional expire/singleton options. */
  schedule(name: string, cron: string, data?: unknown, options?: ScheduleOptions): Promise<void>
}

/** Map the shared EnqueueOptions onto pg-boss SendOptions. */
function toSendOptions(opts?: EnqueueOptions): PgBoss.SendOptions {
  const out: PgBoss.SendOptions = {}
  if (opts?.singletonKey !== undefined) out.singletonKey = opts.singletonKey
  if (opts?.startAfter !== undefined) out.startAfter = opts.startAfter
  if (opts?.retryLimit !== undefined) out.retryLimit = opts.retryLimit
  return out
}

/** Map the worker QueueOptions onto the pg-boss queue policy/retry fields (only set the provided ones). */
function toQueueOptions(
  opts?: QueueOptions,
): Pick<PgBoss.Queue, "retryLimit" | "retryBackoff" | "policy"> {
  const out: Pick<PgBoss.Queue, "retryLimit" | "retryBackoff" | "policy"> = {}
  if (opts?.retryLimit !== undefined) out.retryLimit = opts.retryLimit
  if (opts?.retryBackoff !== undefined) out.retryBackoff = opts.retryBackoff
  if (opts?.policy !== undefined) out.policy = opts.policy
  return out
}

/** pg-boss graceful-stop timeout (ms). MUST be >= the longest per-job budget (media.checks 60s). */
const STOP_GRACE_MS = 65_000

/** Real pg-boss-backed implementation of the worker Jobs handle. */
export class PgBossWorkerJobs implements WorkerJobs {
  private readonly connectionString: string
  private boss: PgBoss | undefined

  constructor(connectionString: string) {
    this.connectionString = connectionString
  }

  async start(): Promise<void> {
    if (this.boss) return
    const { default: PgBossCtor } = await import("pg-boss")
    const boss = new PgBossCtor(this.connectionString)
    // Surface internal errors loudly instead of crashing the process.
    boss.on("error", (err: Error) => console.error("pg-boss error:", err))
    await boss.start()
    this.boss = boss
  }

  async stop(): Promise<void> {
    if (!this.boss) return
    // Graceful: let in-flight jobs finish, then close. wait:true resolves after fully stopped. The
    // explicit timeout must be >= the longest per-job budget (media.checks has a 60s MEDIA_JOB_TIMEOUT_MS
    // wall-clock): pg-boss's 30s graceful default would abandon an in-flight media job on SIGTERM (the
    // asset stuck `validating` until a sweep reconciles), so we raise it to 65s (the container SIGKILL
    // grace must allow for this).
    await this.boss.stop({ graceful: true, wait: true, timeout: STOP_GRACE_MS })
    this.boss = undefined
  }

  private requireBoss(): PgBoss {
    if (!this.boss) throw new Error("pg-boss not started")
    return this.boss
  }

  async createQueue(name: string, options?: QueueOptions): Promise<void> {
    const boss = this.requireBoss()
    // Build the pg-boss queue policy from the optional retry knobs. createQueue is a no-op if the queue
    // already exists, so updateQueue is what actually brings a previously-created (e.g. retryLimit=0)
    // queue to the right policy. Both are idempotent (mirrors the API adapter's createQueue/updateQueue).
    const queuePolicy: PgBoss.Queue = { name, ...toQueueOptions(options) }
    await boss.createQueue(name, queuePolicy)
    if (
      options?.retryLimit !== undefined ||
      options?.retryBackoff !== undefined ||
      options?.policy !== undefined
    ) {
      await boss.updateQueue(name, queuePolicy)
    }
  }

  async enqueue(name: string, data: unknown, opts?: EnqueueOptions): Promise<string> {
    const id = await this.requireBoss().send(name, data as object, toSendOptions(opts))
    return id ?? ""
  }

  async schedule(
    name: string,
    cron: string,
    data?: unknown,
    options?: ScheduleOptions,
  ): Promise<void> {
    const sendOpts: PgBoss.ScheduleOptions = {}
    if (options?.expireInSeconds !== undefined) sendOpts.expireInSeconds = options.expireInSeconds
    if (options?.singletonKey !== undefined) sendOpts.singletonKey = options.singletonKey
    await this.requireBoss().schedule(name, cron, (data as object) ?? {}, sendOpts)
  }

  async work(name: string, handler: JobHandler): Promise<void> {
    await this.workWithSettings(name, handler)
  }

  async workWithSettings(
    name: string,
    handler: JobHandler,
    settings?: WorkSettings,
  ): Promise<void> {
    const options: PgBoss.WorkOptions = {}
    if (settings?.batchSize !== undefined) options.batchSize = settings.batchSize
    if (settings?.pollingIntervalSeconds !== undefined) {
      options.pollingIntervalSeconds = settings.pollingIntervalSeconds
    }
    await this.requireBoss().work(name, options, async (jobs: PgBoss.Job[]) => {
      // pg-boss v10 delivers a BATCH array and fails the WHOLE batch (re-delivering every sibling) if this
      // callback throws. The media.checks handler DELIBERATELY re-throws MediaInfraError to signal a retry,
      // so a Promise.all would let one infra-failing job re-process every clean sibling. Use allSettled and
      // re-throw ONLY if a settled rejection is infra: a clean sibling is never re-delivered for another
      // job's transient storage/DB blip, while a real infra failure still triggers the bounded retry. The
      // never-throw-on-untrusted-input invariant means only MediaInfraError ever rejects here.
      const results = await Promise.allSettled(jobs.map((j) => handler({ id: j.id, data: j.data })))
      const infra = results.find(
        (r): r is PromiseRejectedResult =>
          r.status === "rejected" && r.reason instanceof MediaInfraError,
      )
      if (infra) throw infra.reason
    })
  }

  async complete(jobId: string): Promise<void> {
    // The shared Jobs.complete is name-agnostic; pg-boss v10 needs the queue name. The worker's handlers
    // complete implicitly by resolving, so this is never called on the worker. Log if it ever is (a
    // silent no-op would mask a misuse) rather than guessing a queue name.
    console.warn("PgBossWorkerJobs.complete is unsupported on the worker (handlers complete by resolving)", {
      jobId,
    })
    return Promise.resolve()
  }

  async fail(jobId: string, err?: unknown): Promise<void> {
    // Likewise unsupported: a silent no-op would discard both the job AND its error. Log so the misuse is
    // diagnosable; the worker never calls this (handlers signal failure by throwing).
    console.warn("PgBossWorkerJobs.fail is unsupported on the worker (throw to fail a job instead)", {
      jobId,
      err: err === undefined ? undefined : String(err),
    })
    return Promise.resolve()
  }
}

export interface JobsHandle {
  jobs: WorkerJobs
  start(): Promise<void>
  stop(): Promise<void>
}

/**
 * Fake-backed handle: wraps FakeJobs to satisfy the WorkerJobs surface (createQueue/workWithSettings
 * are no-ops/aliases) so the same worker wiring runs offline.
 */
class FakeWorkerJobs extends FakeJobs implements WorkerJobs {
  start(): Promise<void> {
    return Promise.resolve()
  }
  stop(): Promise<void> {
    return Promise.resolve()
  }
  createQueue(_name: string, _options?: QueueOptions): Promise<void> {
    return Promise.resolve()
  }
  workWithSettings(name: string, handler: JobHandler, _settings?: WorkSettings): Promise<void> {
    return this.work(name, handler)
  }
}

/** Build the Jobs seam for the worker, selecting fake vs real per USE_FAKE_JOBS. */
export function buildJobs(source: NodeJS.ProcessEnv = process.env): JobsHandle {
  if (useFakeJobs(source)) {
    const jobs = new FakeWorkerJobs()
    return { jobs, start: () => jobs.start(), stop: () => jobs.stop() }
  }
  const connectionString = (source.DATABASE_URL ?? "").trim()
  if (!connectionString) {
    throw new Error("media-worker: DATABASE_URL is required when USE_FAKE_JOBS is off")
  }
  const real = new PgBossWorkerJobs(connectionString)
  return { jobs: real, start: () => real.start(), stop: () => real.stop() }
}
