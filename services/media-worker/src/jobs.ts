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
 *   - the batch is completed/failed PER JOB here rather than by resolving/throwing out of the work
 *     callback, which pg-boss treats as a verdict on the whole batch (see workWithSettings).
 */

import type PgBoss from "pg-boss"
import type { Jobs, EnqueueOptions, JobHandler } from "@civfix/shared/interfaces"
import { FakeJobs } from "@civfix/shared/fakes"
import { assertRealSeamInProd, loadLimits, parseBool } from "./config.js"

/** Default ON outside production so the worker boots offline; an explicit ON in prod fails boot. */
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

/**
 * Shape the failure written to the job's `output` column. pg-boss serializes an Error faithfully
 * (serialize-error), so pass it straight through; anything else is wrapped so the reason is never lost.
 */
function toFailureOutput(err: unknown): object {
  return err instanceof Error ? err : { message: String(err) }
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

/**
 * Slack added to the per-job budget when sizing the graceful-stop timeout: the budget bounds processing,
 * not the persist round-trips that follow it.
 */
const STOP_GRACE_MARGIN_MS = 5_000

/**
 * How many times a media.checks handler can pay the per-job budget in one run.
 *
 * MEDIA_JOB_TIMEOUT_MS is applied PER PHASE, not per job: jobs/media-checks.ts wraps the download in one
 * withJobTimeout and processMedia in a SECOND one, so a job that stalls in both phases runs for ~2x the
 * budget before it even reaches the persist writes. Sizing the graceful stop at 1x therefore abandoned an
 * in-flight job that was still inside its own budget (the asset left `validating` until a sweep reconciles
 * it). Deriving 2x + margin here keeps the two consistent without collapsing the phases into one shared
 * budget, which would make a slow download eat the processing budget.
 */
const STOP_GRACE_PHASES = 2

/**
 * The graceful-stop timeout for a given per-job budget: every phase's budget plus the persist margin.
 * Exported because it is the number the CONTAINER's SIGKILL grace must exceed (civfix-infra compose
 * `stop_grace_period`) - see stop().
 */
export function stopGraceMsFor(jobTimeoutMs: number): number {
  return STOP_GRACE_PHASES * jobTimeoutMs + STOP_GRACE_MARGIN_MS
}

/** Real pg-boss-backed implementation of the worker Jobs handle. */
export class PgBossWorkerJobs implements WorkerJobs {
  private readonly connectionString: string
  /** Graceful-stop timeout (ms), DERIVED from the per-job budget rather than a constant. See stop(). */
  private readonly stopGraceMs: number
  private boss: PgBoss | undefined

  constructor(connectionString: string, jobTimeoutMs: number = loadLimits().jobTimeoutMs) {
    this.connectionString = connectionString
    this.stopGraceMs = stopGraceMsFor(jobTimeoutMs)
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
    // explicit timeout must EXCEED the longest per-job budget (media.checks' MEDIA_JOB_TIMEOUT_MS
    // wall-clock, charged ONCE PER PHASE - see stopGraceMsFor): pg-boss's 30s graceful default would
    // abandon an in-flight media job on SIGTERM (the asset stuck `validating` until a sweep reconciles).
    // That budget is ENV-TUNABLE, so the timeout is derived from it at construction instead of being a
    // constant an operator can silently outgrow by raising MEDIA_JOB_TIMEOUT_MS.
    //
    // OPERATOR REQUIREMENT (different repo): the media-worker container's `stop_grace_period` in the
    // civfix-infra compose file must EXCEED this value, or the runtime SIGKILLs the process mid-job and the
    // derivation buys nothing. At the default budget that is 125s, so the compose needs >= ~150s (Docker's
    // default is 10s). Raising MEDIA_JOB_TIMEOUT_MS raises this requirement with it.
    await this.boss.stop({ graceful: true, wait: true, timeout: this.stopGraceMs })
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
    const boss = this.requireBoss()
    await boss.work(name, options, async (jobs: PgBoss.Job[]) => {
      // pg-boss v10 delivers a BATCH array and treats the callback's outcome as a verdict on the WHOLE
      // batch: it completes every id when the callback resolves and FAILS every id when it throws
      // (manager.js onFetch). Both are wrong for us. The media.checks handler deliberately throws
      // MediaInfraError to request a retry, so throwing out of here would re-deliver every clean sibling
      // (burning its retryLimit and re-downloading/re-decoding/re-encoding bytes that already succeeded,
      // which for a JPEG also means a second lossy pass; the abuse_flags rows themselves are safe, since
      // drizzle/0056_abuse_flags_worker_open_unique.sql plus insertAbuseFlag's ON CONFLICT DO NOTHING keep
      // one OPEN worker flag per subject+reason); resolving instead would mark the failed
      // job COMPLETE and lose it. So each job is completed/failed INDIVIDUALLY by id and the callback
      // resolves, leaving pg-boss's batch-level complete a no-op (completeJobs only matches state
      // 'active', and a failed job has already left it).
      //
      // Any throw - not just MediaInfraError - fails that one job and gets the queue's bounded retry: an
      // unexpected error is a bug, and silently completing the job would hide it AND wedge the asset.
      const settled = await Promise.allSettled(
        jobs.map(async (j) => {
          try {
            await handler({ id: j.id, data: j.data })
          } catch (err) {
            await boss.fail(name, j.id, toFailureOutput(err))
            return
          }
          await boss.complete(name, j.id)
        }),
      )
      // A rejection here is the complete/fail WRITE failing (DB blip), not the handler: rethrow so
      // pg-boss's batch-level fail retries the batch rather than losing the outcome silently. Jobs
      // already marked complete are unaffected (failJobsById only matches state < 'completed').
      const broken = settled.find((r): r is PromiseRejectedResult => r.status === "rejected")
      if (broken) throw broken.reason instanceof Error ? broken.reason : new Error(String(broken.reason))
    })
  }

  async complete(jobId: string): Promise<void> {
    // The shared Jobs.complete is name-agnostic; pg-boss v10 needs the queue name. workWithSettings
    // completes each delivered job itself (where the queue name IS known), so nothing on the worker calls
    // this. Log if it ever is (a silent no-op would mask a misuse) rather than guessing a queue name.
    console.warn("PgBossWorkerJobs.complete is unsupported on the worker (the work loop completes jobs)", {
      jobId,
    })
    return Promise.resolve()
  }

  async fail(jobId: string, err?: unknown): Promise<void> {
    // Likewise unsupported for want of a queue name: a silent no-op would discard both the job AND its
    // error. Handlers signal failure by throwing; the work loop fails that job by id.
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
  const fakeJobs = useFakeJobs(source)
  // PRODUCTION GUARD (mirrors buildSeams' USE_FAKE_STORAGE guard): FakeJobs consumes NOTHING from
  // pg-boss, so a worker booted with it in production starts cleanly, reports healthy, and every uploaded
  // media stays `validating` forever with no error anywhere - the silent no-op the storage guard exists
  // to prevent, in the one seam that makes the whole process pointless.
  assertRealSeamInProd(
    source,
    "USE_FAKE_JOBS",
    fakeJobs,
    "FakeJobs consumes nothing from pg-boss, so every uploaded media would stay 'validating' forever. " +
      "Provide DATABASE_URL and leave USE_FAKE_JOBS unset.",
  )
  if (fakeJobs) {
    const jobs = new FakeWorkerJobs()
    return { jobs, start: () => jobs.start(), stop: () => jobs.stop() }
  }
  const connectionString = (source.DATABASE_URL ?? "").trim()
  if (!connectionString) {
    throw new Error("media-worker: DATABASE_URL is required when USE_FAKE_JOBS is off")
  }
  const real = new PgBossWorkerJobs(connectionString, loadLimits(source).jobTimeoutMs)
  return { jobs: real, start: () => real.start(), stop: () => real.stop() }
}
