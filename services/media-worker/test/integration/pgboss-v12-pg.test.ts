/**
 * pg-boss 12 end to end on pgboss_v12 (Docker-gated; SKIPS without Docker). The three real adapters that
 * share the queues (the API's PgBossJobs, the worker's PgBossWorkerJobs and the filer's PgBossFilerJobs)
 * against one database: whichever boots first, every queue ends with the same policy and retries; a
 * media.checks job the API enqueues is processed by the worker's own handler over FakeStorage and the
 * Drizzle repo, retried on a MediaInfraError and never failed on bad bytes; and a graceful stop lets the
 * job in flight finish.
 */

import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { FakeAbuseChecks, FakeStorage } from "@civfix/seams"
import { makeDrizzleMediaWorkerRepository } from "@civfix/api/media-repo"
import { API_QUEUE_NAMES, PgBossJobs } from "@civfix/api/jobs-pgboss"
import { FILING_QUEUE_OPTIONS, type FilingQueueName } from "@civfix/api/filings-worker"
import { MEDIA_CHECKS_JOB } from "@civfix/api/queue-names"
import { PgBossFilerJobs } from "@civfix/city-filer/jobs"
import { loadLimits } from "../../src/config.js"
import { makeDownloader, type DownloadFn } from "../../src/download.js"
import { MediaInfraError } from "../../src/jobs/media-checks.js"
import type { WorkerSeams } from "../../src/seams.js"
import { makeMediaChecksHandler, WORKER_QUEUES } from "../../src/worker.js"
import { PgBossWorkerJobs, STOP_GRACE_MS } from "../../src/worker-jobs.js"
import { withWorkerPg, type WorkerPgHarness } from "../helpers/pg.js"
import * as fx from "../fixtures/make.js"

const pg = await withWorkerPg()

const JOB_SETTLED_MS = 30_000

interface QueueRow {
  name: string
  policy: string
  retry_limit: number
  retry_delay: number
  retry_backoff: boolean
  expire_seconds: number
}

interface ListOptions {
  policy?: string | undefined
  retryLimit?: number
  retryDelay?: number
  retryBackoff?: boolean
  expireInSeconds?: number
}

/** The API's options per queue today: data.export's backoff, and each filing queue's entry. */
function apiOptions(name: string): ListOptions {
  const filing: Partial<Record<string, ListOptions>> = FILING_QUEUE_OPTIONS
  if (name === "data.export") {
    return { policy: "short", retryLimit: 10, retryDelay: 60, retryBackoff: true }
  }
  return { policy: "short", ...filing[name] }
}

/** Every queue of the three lists, as pgboss_v12.queue should hold it: the lists' values, else pg-boss's defaults. */
function expectedQueues(): QueueRow[] {
  const merged = new Map<string, ListOptions>()
  const add = (name: string, options: ListOptions) => {
    const prev = merged.get(name) ?? {}
    if (prev.policy !== undefined && options.policy !== prev.policy) {
      throw new Error(`${name}: the lists disagree on its policy`)
    }
    merged.set(name, { ...prev, ...options })
  }
  for (const name of API_QUEUE_NAMES) add(name, apiOptions(name))
  for (const [name, options] of WORKER_QUEUES) add(name, options)
  for (const [name, options] of Object.entries(FILING_QUEUE_OPTIONS)) add(name, options)
  return [...merged]
    .map(([name, o]) => ({
      name,
      policy: o.policy ?? "standard",
      retry_limit: o.retryLimit ?? 2,
      retry_delay: o.retryDelay ?? 0,
      retry_backoff: o.retryBackoff ?? false,
      expire_seconds: o.expireInSeconds ?? 900,
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

describe.skipIf(!pg)("pg-boss 12 on pgboss_v12 (integration)", () => {
  let h: WorkerPgHarness

  async function queueRows(): Promise<QueueRow[]> {
    return h.sql<QueueRow[]>`
      SELECT name, policy, retry_limit, retry_delay, retry_backoff, expire_seconds
      FROM pgboss_v12.queue
      ORDER BY name COLLATE "C"
    `
  }

  const boot = {
    async api() {
      const jobs = new PgBossJobs({ connectionString: h.uri })
      await jobs.start()
      await jobs.stop()
    },
    async worker() {
      const jobs = new PgBossWorkerJobs(h.uri)
      await jobs.start()
      for (const [name, options] of WORKER_QUEUES) await jobs.createQueue(name, options)
      await jobs.stop()
    },
    async filer() {
      const jobs = new PgBossFilerJobs(h.uri)
      await jobs.start()
      const names = Object.keys(FILING_QUEUE_OPTIONS) as FilingQueueName[]
      for (const name of names) await jobs.createQueue(name, FILING_QUEUE_OPTIONS[name])
      await jobs.stop()
    },
  }

  beforeAll(() => {
    h = pg as WorkerPgHarness
  })

  afterAll(async () => {
    await h?.teardown()
  })

  describe("queue creation", () => {
    // pg-boss 12 also creates queues of its own (__pgboss__…); only the lists' queues are ours.
    const sorted = (rows: QueueRow[]) => {
      const ours = new Set(expectedQueues().map((q) => q.name))
      return rows.filter((r) => ours.has(r.name)).sort((a, b) => a.name.localeCompare(b.name))
    }

    it("T9: API, then worker, then filer: every queue has its list's policy and retries", async () => {
      await h.sql`DROP SCHEMA IF EXISTS pgboss_v12 CASCADE`
      await boot.api()
      await boot.worker()
      await boot.filer()

      const rows = sorted(await queueRows())
      expect(rows).toEqual(expectedQueues())
      expect(rows.find((r) => r.name === MEDIA_CHECKS_JOB)).toEqual({
        name: MEDIA_CHECKS_JOB,
        policy: "short",
        retry_limit: 5,
        retry_delay: 0,
        retry_backoff: true,
        expire_seconds: 900,
      })
      const [old] = await h.sql<{ missing: boolean }[]>`
        SELECT to_regnamespace('pgboss') IS NULL AS missing
      `
      expect(old!.missing).toBe(true)
    })

    it("T10: filer, then worker, then API: the same rows, column for column", async () => {
      await h.sql`DROP SCHEMA IF EXISTS pgboss_v12 CASCADE`
      await boot.filer()
      await boot.worker()
      await boot.api()

      expect(sorted(await queueRows())).toEqual(expectedQueues())
    })
  })

  describe("a media.checks job end to end", () => {
    let api: PgBossJobs
    let worker: PgBossWorkerJobs
    const storage = new FakeStorage()
    const realDownload = makeDownloader(storage)
    let download: DownloadFn = realDownload

    async function insertAsset(r2Key: string): Promise<string> {
      const id = randomUUID()
      await h.sql`
        INSERT INTO media_assets (id, upload_id, kind, r2_key, status, byte_size)
        VALUES (${id}, ${randomUUID()}, 'image', ${r2Key}, 'validating', 0)
      `
      return id
    }

    async function enqueueCheck(bytes: Buffer): Promise<{ jobId: string; mediaId: string }> {
      const r2Key = `uploads/2026/11/${randomUUID()}`
      const mediaId = await insertAsset(r2Key)
      await storage.put(r2Key, bytes, { contentType: "image/jpeg" })
      const jobId = await api.enqueue(
        MEDIA_CHECKS_JOB,
        { mediaId, uploadId: mediaId, r2Key, kind: "image" },
        { singletonKey: mediaId },
      )
      expect(jobId).not.toBe("")
      return { jobId, mediaId }
    }

    async function jobRow(id: string): Promise<{ state: string; retry_count: number }> {
      const [row] = await h.sql<{ state: string; retry_count: number }[]>`
        SELECT state, retry_count FROM pgboss_v12.job WHERE name = ${MEDIA_CHECKS_JOB} AND id = ${id}
      `
      if (row === undefined) throw new Error(`no job ${id}`)
      return row
    }

    async function settled(id: string, seen: Set<string> = new Set()) {
      return vi.waitFor(
        async () => {
          const row = await jobRow(id)
          seen.add(row.state)
          if (row.state !== "completed" && row.state !== "failed") throw new Error(row.state)
          return row
        },
        { timeout: JOB_SETTLED_MS, interval: 25 },
      )
    }

    async function assetStatus(id: string): Promise<string> {
      const [row] = await h.sql<{ status: string }[]>`
        SELECT status FROM media_assets WHERE id = ${id}
      `
      return row!.status
    }

    beforeAll(async () => {
      await h.sql`DROP SCHEMA IF EXISTS pgboss_v12 CASCADE`
      api = new PgBossJobs({ connectionString: h.uri })
      await api.start()
      worker = new PgBossWorkerJobs(h.uri)
      await worker.start()
      for (const [name, options] of WORKER_QUEUES) await worker.createQueue(name, options)
      const seams: WorkerSeams = {
        storage,
        inboundStorage: undefined,
        abuseChecks: new FakeAbuseChecks(),
        limits: loadLimits({}),
        download: (key, max, signal) => download(key, max, signal),
        dbHandle: undefined,
        repo: makeDrizzleMediaWorkerRepository(h.db, h.sql),
        anonHoldRepo: undefined,
        findPhashDuplicate: undefined,
        report: () => {},
        close: () => Promise.resolve(),
      }
      await worker.workWithSettings(
        MEDIA_CHECKS_JOB,
        makeMediaChecksHandler(worker, seams, new AbortController().signal),
        { batchSize: 1, pollingIntervalSeconds: 0.5 },
      )
    })

    afterAll(async () => {
      await worker?.stop()
      await api?.stop()
    })

    it("T12: the API enqueues, the worker's handler runs it, the job completes and the asset is ready", async () => {
      download = realDownload
      const { jobId, mediaId } = await enqueueCheck(await fx.makeValidJpegWithGps())

      expect(await settled(jobId)).toEqual({ state: "completed", retry_count: 0 })
      expect(await assetStatus(mediaId)).toBe("ready")
    })

    it("T13: a MediaInfraError on the first download sends the job through retry, then it completes", async () => {
      let downloads = 0
      download = (key, max, signal) => {
        downloads += 1
        return downloads === 1
          ? Promise.reject(new MediaInfraError("download", "storage unavailable"))
          : realDownload(key, max, signal)
      }
      const { jobId, mediaId } = await enqueueCheck(await fx.makeValidJpegWithGps())

      const seen = new Set<string>()
      expect(await settled(jobId, seen)).toEqual({ state: "completed", retry_count: 1 })
      expect(seen.has("retry")).toBe(true)
      expect(await assetStatus(mediaId)).toBe("ready")
    })

    it("T14: crafted bad bytes complete the job on the first try and reject the asset", async () => {
      download = realDownload
      const { jobId, mediaId } = await enqueueCheck(fx.makeGarbageImage())

      const seen = new Set<string>()
      expect(await settled(jobId, seen)).toEqual({ state: "completed", retry_count: 0 })
      expect(seen.has("retry")).toBe(false)
      expect(seen.has("failed")).toBe(false)
      expect(await assetStatus(mediaId)).toBe("rejected")
    })
  })

  describe("graceful stop", () => {
    it("T15: stop() waits for the job in flight to return and completes it, inside STOP_GRACE_MS", async () => {
      const queue = "gh297.slow"
      const jobs = new PgBossWorkerJobs(h.uri)
      await jobs.start()
      await jobs.createQueue(queue, { policy: "short" })
      let started!: () => void
      const running = new Promise<void>((resolve) => {
        started = resolve
      })
      let returnedAt = 0
      await jobs.workWithSettings(
        queue,
        async () => {
          started()
          await new Promise((resolve) => setTimeout(resolve, 2000))
          returnedAt = Date.now()
        },
        { batchSize: 1, pollingIntervalSeconds: 0.5 },
      )
      const id = await jobs.enqueue(queue, {})
      await running
      const [active] = await h.sql<{ state: string }[]>`
        SELECT state FROM pgboss_v12.job WHERE name = ${queue} AND id = ${id}
      `
      expect(active!.state).toBe("active")

      const stopping = Date.now()
      await jobs.stop()
      const stoppedAt = Date.now()

      expect(returnedAt).toBeGreaterThan(0)
      expect(returnedAt).toBeLessThanOrEqual(stoppedAt)
      expect(stoppedAt - stopping).toBeLessThan(STOP_GRACE_MS)
      const [row] = await h.sql<{ state: string }[]>`
        SELECT state FROM pgboss_v12.job WHERE name = ${queue} AND id = ${id}
      `
      expect(row!.state).toBe("completed")
    })
  })
})
