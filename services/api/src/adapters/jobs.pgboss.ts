
import type PgBoss from "pg-boss"
import type { Jobs, EnqueueOptions, JobHandler } from "@civfix/shared/interfaces"

export interface PgBossJobsConfig {
  connectionString: string
  schema?: string
}

export const API_QUEUE_NAMES = [
  "media.checks",
  "jurisdiction.discovery",
  "outreach.digest",
  "inbound.sweep",
  "report.autoforward",
  "data.export",
  "anon.hold.release",
  "cleanup.cancel.fanout",
  "cleanup.guest.update.fanout",
  "guest.retention.sweep",
] as const

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
    boss.on("error", (err: Error) => console.error("pg-boss error:", err))
    await boss.start()
    for (const name of API_QUEUE_NAMES) {
      await boss.createQueue(name, { name, policy: "short" })
      await boss.updateQueue(name, { name, policy: "short" })
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
    await this.requireBoss().work(name, async (jobs: PgBoss.Job[]) => {
      await Promise.all(jobs.map((j) => handler({ id: j.id, data: j.data })))
    })
  }

  async complete(jobId: string): Promise<void> {
    void jobId
    return Promise.resolve()
  }

  async fail(jobId: string, _err?: unknown): Promise<void> {
    void jobId
    return Promise.resolve()
  }
}
