import {
  AppError,
  type AdminDevJobsResponse,
  type AdminDevQueue,
  type AdminDevRunJobResponse,
} from "@civfix/contract"
import type { Jobs } from "@civfix/seams"
import {
  ALL_QUEUE_NAMES,
  ANON_HOLD_RELEASE_JOB,
  ANON_HOLD_RELEASE_SWEEP_JOB,
  CHAT_PARTITION_JOB,
  EVENT_METRICS_ROLLUP_JOB,
  INBOUND_SWEEP_JOB,
  MEDIA_CHECKS_JOB,
  MEDIA_STUCK_SWEEP_JOB,
  MEDIA_UPLOAD_REAP_JOB,
  ORPHAN_SWEEP_JOB,
  RETENTION_SWEEP_JOB,
} from "../../lib/queue-names.js"
import { MS_PER_SECOND } from "../../lib/time.js"
import type { WriteAuditInput } from "./audit.js"
import type { DevJobsRepository, QueueJobStats } from "./dev-jobs-repository.js"

/** The queues the media worker processes. */
export const WORKER_QUEUE_NAMES: ReadonlySet<string> = new Set([
  MEDIA_CHECKS_JOB,
  ANON_HOLD_RELEASE_JOB,
  ORPHAN_SWEEP_JOB,
  CHAT_PARTITION_JOB,
  ANON_HOLD_RELEASE_SWEEP_JOB,
  RETENTION_SWEEP_JOB,
  MEDIA_STUCK_SWEEP_JOB,
  MEDIA_UPLOAD_REAP_JOB,
])

// Only queues that send nothing, delete nothing and are safe to run early: anything else could mail
// people or remove data before its time.
const RUNNABLE_QUEUE_NAMES: ReadonlySet<string> = new Set([
  INBOUND_SWEEP_JOB,
  EVENT_METRICS_ROLLUP_JOB,
  ANON_HOLD_RELEASE_SWEEP_JOB,
  CHAT_PARTITION_JOB,
])

const SORTED_QUEUE_NAMES: readonly string[] = [...ALL_QUEUE_NAMES].sort()

const VIEW_CACHE_TTL_MS = 30 * MS_PER_SECOND

export interface DevJobsServiceDeps {
  repo: DevJobsRepository
  jobs: Jobs
  /** With fake jobs there is no pg-boss schema to read. */
  jobsIsFake: boolean
  audit: (input: WriteAuditInput) => Promise<void>
  now?: () => Date
}

export interface DevJobsService {
  view(): Promise<AdminDevJobsResponse>
  runNow(name: string, actorId: string): Promise<AdminDevRunJobResponse>
}

function emptyStats(name: string): QueueJobStats {
  return {
    name,
    created: 0,
    retry: 0,
    active: 0,
    failed: 0,
    failedLast24h: 0,
    oldestDueAt: null,
    lastCompletedAt: null,
  }
}

function toQueue(stats: QueueJobStats, schedule: string | null, now: Date): AdminDevQueue {
  const { name, oldestDueAt, lastCompletedAt } = stats
  return {
    name,
    owner: WORKER_QUEUE_NAMES.has(name) ? "worker" : "api",
    schedule,
    counts: {
      created: stats.created,
      retry: stats.retry,
      active: stats.active,
      failed: stats.failed,
    },
    failedLast24h: stats.failedLast24h,
    oldestPendingSeconds:
      oldestDueAt === null
        ? 0
        : Math.max(0, Math.floor((now.getTime() - oldestDueAt.getTime()) / MS_PER_SECOND)),
    lastCompletedAt: lastCompletedAt === null ? null : lastCompletedAt.toISOString(),
    runnable: RUNNABLE_QUEUE_NAMES.has(name),
  }
}

export function makeDevJobsService(deps: DevJobsServiceDeps): DevJobsService {
  const { repo, jobs, jobsIsFake, audit } = deps
  const now = deps.now ?? (() => new Date())
  // The promise is cached, so concurrent views within the window share one read.
  let cached: { at: number; view: Promise<AdminDevJobsResponse> } | null = null

  async function read(at: Date): Promise<AdminDevJobsResponse> {
    const snapshot = await repo.snapshot(SORTED_QUEUE_NAMES)
    const stats = new Map(snapshot.stats.map((s) => [s.name, s]))
    const schedules = new Map(snapshot.schedules.map((s) => [s.name, s.cron]))
    return {
      queues: SORTED_QUEUE_NAMES.map((name) =>
        toQueue(stats.get(name) ?? emptyStats(name), schedules.get(name) ?? null, at),
      ),
    }
  }

  return {
    view(): Promise<AdminDevJobsResponse> {
      const at = now()
      if (jobsIsFake) {
        return Promise.resolve({
          queues: SORTED_QUEUE_NAMES.map((name) => toQueue(emptyStats(name), null, at)),
        })
      }
      if (cached !== null && at.getTime() - cached.at < VIEW_CACHE_TTL_MS) return cached.view
      const entry = { at: at.getTime(), view: read(at) }
      cached = entry
      void entry.view.catch(() => {
        if (cached === entry) cached = null
      })
      return entry.view
    },

    async runNow(name: string, actorId: string): Promise<AdminDevRunJobResponse> {
      if (!RUNNABLE_QUEUE_NAMES.has(name)) throw AppError.notFound()
      let enqueued = false
      if (!jobsIsFake) {
        const state = await repo.runState(name)
        if (!state.exists) throw AppError.notFound()
        if (!state.waiting) {
          // The worker's cron sends its sweeps with the queue name as singletonKey, and the
          // "singleton" policy keeps one active job per key, so the same key keeps a manual run from
          // running alongside the cron's. That policy still allows a second created job, hence the
          // waiting check above. No id means pg-boss's policy refused a run that raced this one.
          const id = WORKER_QUEUE_NAMES.has(name)
            ? await jobs.enqueue(name, {}, { singletonKey: name })
            : await jobs.enqueue(name, {})
          enqueued = id !== ""
        }
      }
      await audit({ actorId, action: "dev.job_run", target: `queue:${name}`, meta: { enqueued } })
      return { enqueued }
    },
  }
}
