/**
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
import type { Jobs, EnqueueOptions, JobHandler } from "@civfix/seams"
import { FakeJobs } from "@civfix/seams"
import { parseBool } from "@civfix/api/env-parsers"
import { assertRealSeamInProd } from "./config.js"

/** Default ON outside production so the worker boots offline; an explicit ON in prod fails boot. */
function useFakeJobs(source: NodeJS.ProcessEnv = process.env): boolean {
  const isProd = source.NODE_ENV === "production"
  return parseBool(source.USE_FAKE_JOBS, !isProd)
}

export interface WorkSettings {
  /** Bounds in-flight concurrency. */
  batchSize?: number
  pollingIntervalSeconds?: number
}

/**
 * The queue-level retry policy is what makes media.checks' infra throws (MediaInfraError) recover with
 * bounded backoff. pg-boss v10's default retryLimit is 2 (retries are opt-OUT), but callers set it
 * explicitly so the value is intentional, not inherited. The worker owns the work side, so it is set on
 * the worker's createQueue; the fake ignores it.
 */
export interface QueueOptions {
  retryLimit?: number
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

export interface ScheduleOptions {
  /** Sized above the worst-case run, since an expired job is re-delivered. */
  expireInSeconds?: number
  /** Single-flight key so two fires of the same cron never overlap. */
  singletonKey?: string
}

export interface WorkerJobs extends Jobs {
  start(): Promise<void>
  stop(): Promise<void>
  /** Idempotent; pg-boss v10 requires the queue before send/work. */
  createQueue(name: string, options?: QueueOptions): Promise<void>
  workWithSettings(name: string, handler: JobHandler, settings?: WorkSettings): Promise<void>
  schedule(name: string, cron: string, data?: unknown, options?: ScheduleOptions): Promise<void>
}

/**
 * pg-boss serializes an Error faithfully (serialize-error) into the job's `output`; anything else is
 * wrapped so the reason is never lost.
 */
function toFailureOutput(err: unknown): object {
  return err instanceof Error ? err : { message: String(err) }
}

function toSendOptions(opts?: EnqueueOptions): PgBoss.SendOptions {
  const out: PgBoss.SendOptions = {}
  if (opts?.singletonKey !== undefined) out.singletonKey = opts.singletonKey
  if (opts?.startAfter !== undefined) out.startAfter = opts.startAfter
  if (opts?.retryLimit !== undefined) out.retryLimit = opts.retryLimit
  return out
}

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
 * How long a job that is in flight at SIGTERM may keep running. After it the worker interrupts the job
 * (jobs/media-checks.ts) and hands it back with JobInterruptedError, so a deploy waits seconds, not a
 * transcode.
 */
export const IN_FLIGHT_GRACE_MS = 30_000

/**
 * After the interrupt: an interrupted job winds down and is handed back within milliseconds, and a job
 * that was already writing its result finishes those writes. Only past this does pg-boss fail what is
 * still active, which costs that job one retry.
 */
const HAND_BACK_MARGIN_MS = 15_000

/**
 * The graceful-stop timeout passed to pg-boss. The container's SIGKILL grace (civfix-infra compose
 * `stop_grace_period`) must exceed it; see stop().
 */
export const STOP_GRACE_MS = IN_FLIGHT_GRACE_MS + HAND_BACK_MARGIN_MS

/**
 * Thrown by a handler whose job was interrupted because the worker is stopping. The work loop hands the
 * job back instead of failing it: an interruption says nothing about the job, so it must not spend one of
 * the retries that decide whether an upload is given up on.
 */
export class JobInterruptedError extends Error {
  constructor() {
    super("the worker stopped before this job finished")
    this.name = "JobInterruptedError"
    Object.setPrototypeOf(this, JobInterruptedError.prototype)
  }
}

/**
 * Queue an interrupted job again as a fresh job and complete the interrupted one. pg-boss has no way to
 * return an active job to the queue as it was: fail, and cancel + resume, both leave started_on set, so the
 * next fetch counts a retry. The fresh job is sent first, so a failure between the two writes leaves a
 * duplicate (the asset's status makes the second run a no-op) rather than a lost job. Under the "short"
 * policy a job already waiting with the same singletonKey dedups the send, and that job does the work.
 */
async function handBack(boss: PgBoss, name: string, job: PgBoss.JobWithMetadata): Promise<void> {
  const requeuedAs = await boss.send(
    name,
    job.data,
    job.singletonKey !== null ? { singletonKey: job.singletonKey } : {},
  )
  await boss.complete(name, job.id, { interrupted: true, requeuedAs })
}

/**
 * pg-boss v10 delivers a BATCH array and treats the callback's outcome as a verdict on the WHOLE batch: it
 * completes every id when the callback resolves and FAILS every id when it throws (manager.js onFetch).
 * Both are wrong for us. The media.checks handler deliberately throws MediaInfraError to request a retry,
 * so throwing out of the callback would re-deliver every clean sibling (burning its retryLimit and
 * re-downloading/re-decoding/re-encoding bytes that already succeeded, which for a JPEG also means a
 * second lossy pass; the abuse_flags rows themselves are safe, since
 * drizzle/0056_abuse_flags_worker_open_unique.sql plus insertAbuseFlag's ON CONFLICT DO NOTHING keep one
 * OPEN worker flag per subject+reason); resolving instead would mark the failed job COMPLETE and lose it.
 * So each job is completed/failed INDIVIDUALLY by id and the callback resolves, leaving pg-boss's
 * batch-level complete a no-op (completeJobs only matches state 'active', and a failed job has already
 * left it).
 *
 * Any throw - not just MediaInfraError - fails that one job and gets the queue's bounded retry: an
 * unexpected error is a bug, and silently completing the job would hide it AND wedge the asset.
 */
async function settleEachJob(
  boss: PgBoss,
  name: string,
  jobs: PgBoss.JobWithMetadata[],
  handler: JobHandler,
): Promise<void> {
  const settled = await Promise.allSettled(
    jobs.map(async (j) => {
      try {
        await handler({ id: j.id, data: j.data })
      } catch (err) {
        if (err instanceof JobInterruptedError) {
          await handBack(boss, name, j)
          return
        }
        await boss.fail(name, j.id, toFailureOutput(err))
        return
      }
      await boss.complete(name, j.id)
    }),
  )
  // A rejection here is the complete/fail WRITE failing (DB blip), not the handler: rethrow so pg-boss's
  // batch-level fail retries the batch rather than losing the outcome silently. Jobs already marked
  // complete are unaffected (failJobsById only matches state < 'completed').
  const broken = settled.find((r): r is PromiseRejectedResult => r.status === "rejected")
  if (broken)
    throw broken.reason instanceof Error ? broken.reason : new Error(String(broken.reason))
}

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
    // Without a listener an internal pg-boss error would crash the process.
    boss.on("error", (err: Error) => console.error("pg-boss error:", err))
    await boss.start()
    this.boss = boss
  }

  async stop(): Promise<void> {
    if (!this.boss) return
    // Graceful: pg-boss stops fetching at once and waits for the jobs in flight. The worker interrupts
    // those after IN_FLIGHT_GRACE_MS and they hand themselves back, so the wait ends then; STOP_GRACE_MS
    // only bounds a job that was writing its result at that moment.
    //
    // OPERATOR REQUIREMENT (different repo): the media-worker container's `stop_grace_period` in the
    // civfix-infra compose file must EXCEED STOP_GRACE_MS (45s), or the runtime SIGKILLs the process
    // before an interrupted job is handed back (Docker's default is 10s). The compose sets 200s.
    await this.boss.stop({ graceful: true, wait: true, timeout: STOP_GRACE_MS })
    this.boss = undefined
  }

  private requireBoss(): PgBoss {
    if (!this.boss) throw new Error("pg-boss not started")
    return this.boss
  }

  async createQueue(name: string, options?: QueueOptions): Promise<void> {
    const boss = this.requireBoss()
    // createQueue is a no-op if the queue already exists, so updateQueue is what brings a
    // previously-created (e.g. retryLimit=0) queue to the right policy. Mirrors the API adapter.
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
    // The metadata carries the singletonKey a handed-back job is re-sent with.
    const options: PgBoss.WorkOptions & { includeMetadata: true } = { includeMetadata: true }
    if (settings?.batchSize !== undefined) options.batchSize = settings.batchSize
    if (settings?.pollingIntervalSeconds !== undefined) {
      options.pollingIntervalSeconds = settings.pollingIntervalSeconds
    }
    const boss = this.requireBoss()
    await boss.work(name, options, (jobs: PgBoss.JobWithMetadata[]) =>
      settleEachJob(boss, name, jobs, handler),
    )
  }

  async complete(jobId: string): Promise<void> {
    // The shared Jobs.complete is name-agnostic; pg-boss v10 needs the queue name. workWithSettings
    // completes each delivered job itself (where the queue name IS known), so nothing on the worker calls
    // this. Log if it ever is (a silent no-op would mask a misuse) rather than guessing a queue name.
    console.warn(
      "PgBossWorkerJobs.complete is unsupported on the worker (the work loop completes jobs)",
      {
        jobId,
      },
    )
    return Promise.resolve()
  }

  async fail(jobId: string, err?: unknown): Promise<void> {
    // Likewise unsupported for want of a queue name: a silent no-op would discard both the job AND its
    // error. Handlers signal failure by throwing; the work loop fails that job by id.
    console.warn(
      "PgBossWorkerJobs.fail is unsupported on the worker (throw to fail a job instead)",
      {
        jobId,
        // eslint-disable-next-line @typescript-eslint/no-base-to-string -- best-effort rendering of an arbitrary failure value for a warning log
        err: err === undefined ? undefined : String(err),
      },
    )
    return Promise.resolve()
  }
}

export interface JobsHandle {
  jobs: WorkerJobs
  start(): Promise<void>
  stop(): Promise<void>
}

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

export function makeJobs(source: NodeJS.ProcessEnv = process.env): JobsHandle {
  const fakeJobs = useFakeJobs(source)
  // Mirrors makeSeams' USE_FAKE_STORAGE guard: FakeJobs consumes NOTHING from
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
  const real = new PgBossWorkerJobs(connectionString)
  return { jobs: real, start: () => real.start(), stop: () => real.stop() }
}
