import type { JobWithMetadata, PgBoss, Queue, SendOptions } from "pg-boss"
import type { Jobs, EnqueueOptions, JobHandler } from "@civfix/seams"
import type { JobHandlerArgWithAttempt } from "../services/job-attempt.js"
import {
  ANON_HOLD_RELEASE_JOB,
  BROADCAST_CHUNK_JOB,
  BROADCAST_PLAN_JOB,
  BROADCAST_SCHEDULE_SWEEP_JOB,
  CHAT_ROOM_FANOUT_JOB,
  CHECKIN_NOSHOW_SWEEP_JOB,
  CLEANUP_CANCEL_FANOUT_JOB,
  CLEANUP_GUEST_UPDATE_FANOUT_JOB,
  DATA_EXPORT_JOB,
  EVENT_METRICS_ROLLUP_JOB,
  EVENT_REMINDERS_SWEEP_JOB,
  FILING_CITY_UPDATE_JOB,
  FILING_CLASSIFY_JOB,
  FILING_EMAIL_JOB,
  FILING_QUEUE_OPTIONS,
  FILING_RESULT_JOB,
  FILING_RUN_JOB,
  FILING_SWEEP_JOB,
  GUEST_RETENTION_SWEEP_JOB,
  HOST_EXPORT_JOB,
  HOST_EXPORT_REAP_JOB,
  HOST_RETENTION_SWEEP_JOB,
  INBOUND_SWEEP_JOB,
  JURISDICTION_DISCOVERY_JOB,
  MEDIA_CHECKS_JOB,
  OUTREACH_DIGEST_JOB,
  PGBOSS_SCHEMA,
  PUSH_CLEAR_JOB,
  SHARED_QUEUE_POLICY,
  WAITLIST_EXPIRE_SWEEP_JOB,
  WAITLIST_PROMOTE_JOB,
} from "../lib/queue-names.js"
import { SECONDS_PER_MINUTE } from "../lib/time.js"

export interface PgBossJobsLogger {
  error(obj: unknown, msg?: string): void
}

// Only for callers that construct the adapter without a logger; the API container always injects
// its pino logger so redaction applies.
const consoleLogger: PgBossJobsLogger = {
  error: (obj, msg) => console.error(msg ?? "", obj),
}

export interface PgBossJobsConfig {
  connectionString: string
  logger?: PgBossJobsLogger
}

export const API_QUEUE_NAMES = [
  MEDIA_CHECKS_JOB,
  JURISDICTION_DISCOVERY_JOB,
  OUTREACH_DIGEST_JOB,
  INBOUND_SWEEP_JOB,
  DATA_EXPORT_JOB,
  ANON_HOLD_RELEASE_JOB,
  CLEANUP_CANCEL_FANOUT_JOB,
  CLEANUP_GUEST_UPDATE_FANOUT_JOB,
  GUEST_RETENTION_SWEEP_JOB,
  CHAT_ROOM_FANOUT_JOB,
  PUSH_CLEAR_JOB,
  WAITLIST_PROMOTE_JOB,
  WAITLIST_EXPIRE_SWEEP_JOB,
  CHECKIN_NOSHOW_SWEEP_JOB,
  BROADCAST_PLAN_JOB,
  BROADCAST_CHUNK_JOB,
  BROADCAST_SCHEDULE_SWEEP_JOB,
  EVENT_REMINDERS_SWEEP_JOB,
  EVENT_METRICS_ROLLUP_JOB,
  HOST_EXPORT_JOB,
  HOST_EXPORT_REAP_JOB,
  HOST_RETENTION_SWEEP_JOB,
  FILING_EMAIL_JOB,
  FILING_RUN_JOB,
  FILING_RESULT_JOB,
  FILING_CLASSIFY_JOB,
  FILING_CITY_UPDATE_JOB,
  FILING_SWEEP_JOB,
] as const

type ApiQueueName = (typeof API_QUEUE_NAMES)[number]

type QueueOptions = Pick<Queue, "retryLimit" | "retryDelay" | "retryBackoff" | "expireInSeconds">

const DATA_EXPORT_RETRY_LIMIT = 10

// pg-boss's own default, which the API relied on before it named one: a shutdown waits this long for
// the jobs the API works (filing results, exports, fan-outs) before pg-boss fails what is still active.
const STOP_TIMEOUT_MS = 30_000

// A data export that fails on a mail credential or approved-sender fault has to wait for an operator to
// fix the config. pg-boss's default (2 immediate retries) would rebuild and resend the whole export three
// times within seconds and then drop the request, so it backs off from a minute to hours instead; the
// handler records the request for an operator on the last attempt.
const QUEUE_OPTIONS: Partial<Record<ApiQueueName, QueueOptions>> = {
  [DATA_EXPORT_JOB]: {
    retryLimit: DATA_EXPORT_RETRY_LIMIT,
    retryDelay: SECONDS_PER_MINUTE,
    retryBackoff: true,
  },
  ...Object.fromEntries(
    Object.entries(FILING_QUEUE_OPTIONS).map(([name, { policy: _policy, ...retries }]) => [
      name,
      retries,
    ]),
  ),
}

function toSendOptions(opts?: EnqueueOptions): SendOptions {
  const out: SendOptions = {}
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

  async start(): Promise<void> {
    if (this.boss) return
    const { PgBoss: PgBossCtor } = await import("pg-boss")
    const boss = new PgBossCtor({
      connectionString: this.config.connectionString,
      schema: PGBOSS_SCHEMA,
    })
    const logger = this.config.logger ?? consoleLogger
    boss.on("error", (err: Error) => logger.error({ err }, "pg-boss error"))
    await boss.start()
    for (const name of API_QUEUE_NAMES) {
      const retries = QUEUE_OPTIONS[name]
      await boss.createQueue(name, { policy: SHARED_QUEUE_POLICY, ...retries })
      // createQueue leaves an existing queue as it is, so updateQueue brings its retries to these.
      if (retries !== undefined) await boss.updateQueue(name, retries)
    }
    this.boss = boss
  }

  async stop(): Promise<void> {
    if (!this.boss) return
    await this.boss.stop({ graceful: true, timeout: STOP_TIMEOUT_MS })
    this.boss = undefined
  }

  private requireBoss(): PgBoss {
    if (!this.boss) throw new Error("pg-boss not started (call jobs.start() before enqueue)")
    return this.boss
  }

  async enqueue(name: string, data: unknown, opts?: EnqueueOptions): Promise<string> {
    const id = await this.requireBoss().send(name, data as object, toSendOptions(opts))
    return id ?? ""
  }

  async schedule(name: string, cron: string, data?: unknown): Promise<void> {
    await this.requireBoss().schedule(name, cron, (data as object) ?? {})
  }

  async work(name: string, handler: JobHandler): Promise<void> {
    await this.requireBoss().work(
      name,
      { includeMetadata: true },
      async (jobs: JobWithMetadata[]) => {
        await Promise.all(
          jobs.map((j) => {
            const arg: JobHandlerArgWithAttempt = {
              id: j.id,
              data: j.data,
              retryCount: j.retryCount,
              retryLimit: j.retryLimit,
            }
            return handler(arg)
          }),
        )
      },
    )
  }

  // The work loop completes or fails each job from its handler's outcome; nothing calls these.
  async complete(_jobId: string): Promise<void> {
    return Promise.resolve()
  }

  async fail(_jobId: string, _err?: unknown): Promise<void> {
    return Promise.resolve()
  }
}
