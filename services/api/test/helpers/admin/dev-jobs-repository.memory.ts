import type {
  DevJobsRepository,
  DevJobsSnapshot,
  QueueJobStats,
  QueueRunState,
} from "../../../src/services/admin/dev-jobs-repository.js"

export type MemoryJobState = "created" | "retry" | "active" | "completed" | "cancelled" | "failed"

export interface MemoryJob {
  name: string
  state: MemoryJobState
  startAfter: Date
  completedOn: Date | null
}

export interface MemoryArchivedJob extends MemoryJob {
  archivedOn: Date
}

const ARCHIVE_WINDOW_MS = 48 * 60 * 60 * 1000
const FAILED_WINDOW_MS = 24 * 60 * 60 * 1000

/** pg-boss's job, archive, schedule and queue tables, read with the drizzle repository's rules. */
export class InMemoryDevJobsRepository implements DevJobsRepository {
  readonly jobs: MemoryJob[] = []
  readonly archive: MemoryArchivedJob[] = []
  readonly schedules = new Map<string, string>()
  readonly queues = new Set<string>()
  readonly snapshotCalls: Date[] = []
  runStateCalls = 0

  constructor(private readonly now: () => Date) {}

  addJob(name: string, state: MemoryJobState, at: { startAfter?: Date; completedOn?: Date } = {}) {
    this.queues.add(name)
    this.jobs.push({
      name,
      state,
      startAfter: at.startAfter ?? new Date(0),
      completedOn: at.completedOn ?? null,
    })
  }

  addArchived(name: string, state: MemoryJobState, completedOn: Date, archivedOn: Date) {
    this.queues.add(name)
    this.archive.push({ name, state, startAfter: new Date(0), completedOn, archivedOn })
  }

  snapshot(names: readonly string[]): Promise<DevJobsSnapshot> {
    const now = this.now()
    this.snapshotCalls.push(now)
    const wanted = new Set(names)
    const archived = this.archive.filter(
      (j) => j.archivedOn.getTime() >= now.getTime() - ARCHIVE_WINDOW_MS,
    )
    const stats = new Map<string, QueueJobStats>()
    const entry = (name: string): QueueJobStats => {
      let found = stats.get(name)
      if (found === undefined) {
        found = {
          name,
          created: 0,
          retry: 0,
          active: 0,
          failed: 0,
          failedLast24h: 0,
          oldestDueAt: null,
          lastCompletedAt: null,
        }
        stats.set(name, found)
      }
      return found
    }
    const failedRecently = (j: MemoryJob) =>
      j.state === "failed" &&
      j.completedOn !== null &&
      j.completedOn.getTime() >= now.getTime() - FAILED_WINDOW_MS
    const noteCompleted = (s: QueueJobStats, j: MemoryJob) => {
      if (j.state !== "completed" || j.completedOn === null) return
      if (s.lastCompletedAt === null || j.completedOn > s.lastCompletedAt) {
        s.lastCompletedAt = j.completedOn
      }
    }
    for (const j of this.jobs) {
      if (!wanted.has(j.name)) continue
      const s = entry(j.name)
      if (j.state === "created" || j.state === "retry" || j.state === "active") s[j.state] += 1
      if (j.state === "failed") s.failed += 1
      if (failedRecently(j)) s.failedLast24h += 1
      if ((j.state === "created" || j.state === "retry") && j.startAfter <= now) {
        if (s.oldestDueAt === null || j.startAfter < s.oldestDueAt) s.oldestDueAt = j.startAfter
      }
      noteCompleted(s, j)
    }
    for (const j of archived) {
      if (!wanted.has(j.name)) continue
      const s = entry(j.name)
      if (failedRecently(j)) s.failedLast24h += 1
      noteCompleted(s, j)
    }
    return Promise.resolve({
      stats: [...stats.values()],
      schedules: [...this.schedules]
        .filter(([name]) => wanted.has(name))
        .map(([name, cron]) => ({ name, cron })),
    })
  }

  runState(name: string): Promise<QueueRunState> {
    this.runStateCalls += 1
    return Promise.resolve({
      exists: this.queues.has(name),
      waiting: this.jobs.some(
        (j) => j.name === name && (j.state === "created" || j.state === "retry"),
      ),
    })
  }
}
