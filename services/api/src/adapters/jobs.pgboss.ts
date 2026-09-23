import type PgBoss from "pg-boss"
import type { Jobs, EnqueueOptions, JobHandler } from "@civfix/shared/interfaces"
import { REGISTRATION_QUEUE_NAMES } from "../services/host/registration-queues.js"
import { COMMS_QUEUE_NAMES } from "../services/host/broadcast-queues.js"
import type { JobHandlerArgWithAttempt } from "../services/job-attempt.js"
import { MEDIA_CHECKS_JOB } from "../services/media-intake-service.js"
import { JURISDICTION_DISCOVERY_JOB } from "../services/jurisdiction-service.js"
import { OUTREACH_DIGEST_JOB } from "../services/admin/jurisdiction-contacts-types.js"
import { INBOUND_SWEEP_JOB } from "../services/admin/inbound-jobs.js"
import { REPORT_AUTOFORWARD_JOB } from "../services/report-service.types.js"
import { DATA_EXPORT_JOB } from "../services/data-export-jobs.js"
import { CLEANUP_CANCEL_FANOUT_JOB } from "../services/cleanup-notifications.js"
import {
  CLEANUP_GUEST_UPDATE_FANOUT_JOB,
  GUEST_RETENTION_SWEEP_JOB,
} from "../services/guest-rsvp-service.js"
import { CHAT_ROOM_FANOUT_JOB } from "../services/chat-fanout-jobs.js"
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
  schema?: string
  logger?: PgBossJobsLogger
}

// Enqueued by the claim route and worked by the media worker, which owns the exported constant.
const ANON_HOLD_RELEASE_JOB = "anon.hold.release"

// The media worker creates media.checks and anon.hold.release with this same policy. pg-boss keeps the
// last createQueue/updateQueue policy, so a mismatch silently breaks singletonKey dedup on those queues.
const SHARED_QUEUE_POLICY = "short"

export const API_QUEUE_NAMES = [
  MEDIA_CHECKS_JOB,
  JURISDICTION_DISCOVERY_JOB,
  OUTREACH_DIGEST_JOB,
  INBOUND_SWEEP_JOB,
  REPORT_AUTOFORWARD_JOB,
  DATA_EXPORT_JOB,
  ANON_HOLD_RELEASE_JOB,
  CLEANUP_CANCEL_FANOUT_JOB,
  CLEANUP_GUEST_UPDATE_FANOUT_JOB,
  GUEST_RETENTION_SWEEP_JOB,
  CHAT_ROOM_FANOUT_JOB,
  ...REGISTRATION_QUEUE_NAMES,
  ...COMMS_QUEUE_NAMES,
] as const

type ApiQueueName = (typeof API_QUEUE_NAMES)[number]

type QueueRetryPolicy = Required<Pick<PgBoss.Queue, "retryLimit" | "retryDelay" | "retryBackoff">>

const DATA_EXPORT_RETRY_LIMIT = 10

// A data export that fails on a mail credential or approved-sender fault has to wait for an operator to
// fix the config. pg-boss's default (2 immediate retries) would rebuild and resend the whole export three
// times within seconds and then drop the request, so it backs off from a minute to hours instead; the
// handler records the request for an operator on the last attempt.
const QUEUE_RETRY_POLICIES: Partial<Record<ApiQueueName, QueueRetryPolicy>> = {
  [DATA_EXPORT_JOB]: {
    retryLimit: DATA_EXPORT_RETRY_LIMIT,
    retryDelay: SECONDS_PER_MINUTE,
    retryBackoff: true,
  },
}

function queueOptions(name: ApiQueueName): PgBoss.Queue {
  return { name, policy: SHARED_QUEUE_POLICY, ...QUEUE_RETRY_POLICIES[name] }
}

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

  async start(): Promise<void> {
    if (this.boss) return
    const { default: PgBossCtor } = await import("pg-boss")
    const boss = new PgBossCtor({
      connectionString: this.config.connectionString,
      ...(this.config.schema !== undefined ? { schema: this.config.schema } : {}),
    })
    const logger = this.config.logger ?? consoleLogger
    boss.on("error", (err: Error) => logger.error({ err }, "pg-boss error"))
    await boss.start()
    for (const name of API_QUEUE_NAMES) {
      await boss.createQueue(name, queueOptions(name))
      await boss.updateQueue(name, queueOptions(name))
    }
    this.boss = boss
  }

  async stop(): Promise<void> {
    if (!this.boss) return
    await this.boss.stop({ graceful: true, wait: true })
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
      async (jobs: PgBoss.JobWithMetadata[]) => {
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
