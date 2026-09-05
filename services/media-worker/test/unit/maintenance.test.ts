
import { describe, expect, it } from "vitest"
import { FakeStorage } from "@civfix/shared/fakes"
import { loadLimits } from "../../src/config.js"
import {
  LEAK_RETRY_MAX_ATTEMPTS,
  resetLegacyServedKeyAdoption,
  runOrphanSweep,
} from "../../src/jobs/orphan-sweep.js"
import { runPartitionMaintenance } from "../../src/jobs/partition-maintenance.js"
import { runStuckSweep } from "../../src/jobs/stuck-sweep.js"
import { MEDIA_CHECKS_JOB } from "@civfix/api/media-repo"
import { InMemoryWorkerRepo } from "../helpers/in-memory-repo.js"
import { MEDIA_UPLOAD_REAP_JOB, uploadReapDelaySec } from "../../src/jobs/upload-reap.js"

const limits = loadLimits({})

describe("orphan.sweep", () => {
  it("deletes only never-attached rows older than the TTL, removing their objects", async () => {
    const storage = new FakeStorage()
    const repo = new InMemoryWorkerRepo()
    const now = new Date("2026-06-01T12:00:00Z")
    const old = new Date(now.getTime() - limits.orphanTtlMs - 60_000)
    const fresh = new Date(now.getTime() - 60_000)

    const orphan = repo.seed({
      id: "orphan-1",
      uploadId: "u1",
      kind: "image",
      r2Key: "uploads/o1",
      reportId: null,
      createdAt: old,
      thumbKey: "thumbs/uploads/o1.jpg",
    })
    await storage.put(orphan.r2Key, Buffer.from([1, 2, 3]))
    await storage.put("thumbs/uploads/o1.jpg", Buffer.from([4, 5]))
    await storage.put("processed/uploads/o1.img", Buffer.from([6, 7]))

    repo.seed({
      id: "attached-1",
      uploadId: "u2",
      kind: "image",
      r2Key: "uploads/a1",
      reportId: "report-123",
      createdAt: old,
    })
    repo.seed({
      id: "fresh-1",
      uploadId: "u3",
      kind: "image",
      r2Key: "uploads/f1",
      reportId: null,
      createdAt: fresh,
    })

    const res = await runOrphanSweep({ repo, storage, limits, now: () => now, log: () => {} })
    expect(res.deleted).toBe(1)
    expect(res.errors).toBe(0)

    expect(repo.byId.has("orphan-1")).toBe(false)
    expect(storage.get("uploads/o1")).toBeNull()
    expect(storage.get("thumbs/uploads/o1.jpg")).toBeNull()
    expect(storage.get("processed/uploads/o1.img")).toBeNull()

    expect(repo.byId.has("attached-1")).toBe(true)
    expect(repo.byId.has("fresh-1")).toBe(true)
  })

  it("never reaps a BOUND row: chat/DM, post, avatar and verification lanes all survive", async () => {
    const storage = new FakeStorage()
    const repo = new InMemoryWorkerRepo()
    const now = new Date("2026-06-01T12:00:00Z")
    const old = new Date(now.getTime() - limits.orphanTtlMs - 60_000)

    const bound = [
      { id: "chat-1", uploadId: "cu", r2Key: "uploads/chat1", chatMessageId: "msg-1" },
      { id: "post-1", uploadId: "pu", r2Key: "uploads/post1", postId: "post-abc", purpose: "post" },
      { id: "verif-1", uploadId: "vu", r2Key: "uploads/verif1", purpose: "verification" },
      { id: "avatar-1", uploadId: "au", r2Key: "uploads/avatar1" },
    ] as const
    for (const row of bound) {
      repo.seed({ ...row, kind: "image", reportId: null, createdAt: old })
      await storage.put(row.r2Key, Buffer.from([1]))
    }
    repo.seedAvatarReference("avatar-1")

    const orphan = repo.seed({
      id: "orphan-only",
      uploadId: "ou",
      kind: "image",
      r2Key: "uploads/orphan-only",
      reportId: null,
      createdAt: old,
    })
    await storage.put(orphan.r2Key, Buffer.from([1]))

    const res = await runOrphanSweep({ repo, storage, limits, now: () => now, log: () => {} })

    expect(res.deleted).toBe(1)
    expect(res.errors).toBe(0)
    expect(repo.byId.has("orphan-only")).toBe(false)
    expect(storage.get("uploads/orphan-only")).toBeNull()

    for (const row of bound) {
      expect(repo.byId.has(row.id), `${row.id} row must survive`).toBe(true)
      expect(storage.get(row.r2Key), `${row.id} object must survive`).not.toBeNull()
    }
  })

  it("M10: DRAINS the backlog across pages instead of reaping one bounded batch per run", async () => {
    const storage = new FakeStorage()
    const repo = new InMemoryWorkerRepo()
    const now = new Date("2026-06-01T12:00:00Z")
    const old = new Date(now.getTime() - limits.orphanTtlMs - 60_000)

    const total = 25
    for (let i = 0; i < total; i++) {
      const row = repo.seed({
        id: `drain-${i}`,
        uploadId: `du${i}`,
        kind: "image",
        r2Key: `uploads/d${i}`,
        reportId: null,
        createdAt: old,
      })
      await storage.put(row.r2Key, Buffer.from([1]))
    }

    const paged = { ...limits, orphanSweepBatch: 10, orphanSweepMaxPages: 50 }
    const res = await runOrphanSweep({ repo, storage, limits: paged, now: () => now, log: () => {} })

    expect(res.deleted).toBe(total)
    expect(res.scanned).toBe(total)
    expect(repo.byId.size).toBe(0)
  })

  it("M10: stops at orphanSweepMaxPages so one run cannot monopolize the worker", async () => {
    const storage = new FakeStorage()
    const repo = new InMemoryWorkerRepo()
    const now = new Date("2026-06-01T12:00:00Z")
    const old = new Date(now.getTime() - limits.orphanTtlMs - 60_000)

    for (let i = 0; i < 30; i++) {
      const row = repo.seed({
        id: `cap-${i}`,
        uploadId: `cu${i}`,
        kind: "image",
        r2Key: `uploads/c${i}`,
        reportId: null,
        createdAt: old,
      })
      await storage.put(row.r2Key, Buffer.from([1]))
    }

    const capped = { ...limits, orphanSweepBatch: 10, orphanSweepMaxPages: 2 }
    const res = await runOrphanSweep({ repo, storage, limits: capped, now: () => now, log: () => {} })

    expect(res.deleted).toBe(20)
    expect(repo.byId.size).toBe(10)
  })

  it("never throws: a per-row delete failure is counted, not propagated", async () => {
    const storage = new FakeStorage()
    const repo = new InMemoryWorkerRepo()
    const now = new Date("2026-06-01T12:00:00Z")
    repo.seed({
      id: "boom",
      uploadId: "u",
      kind: "image",
      r2Key: "uploads/boom",
      reportId: null,
      createdAt: new Date(now.getTime() - limits.orphanTtlMs - 1000),
    })
    repo.deleteOrphan = () => Promise.reject(new Error("delete failed"))

    const reports: unknown[] = []
    const res = await runOrphanSweep({
      repo,
      storage,
      limits,
      now: () => now,
      log: () => {},
      report: (e) => reports.push(e),
    })
    expect(res.errors).toBe(1)
    expect(res.deleted).toBe(0)
    expect(reports.length).toBe(1)
  })

  it("tombstones objects whose delete failed, then reclaims them on the next run", async () => {
    const storage = new FakeStorage()
    const repo = new InMemoryWorkerRepo()
    const now = new Date("2026-06-01T12:00:00Z")
    const realDelete = storage.delete.bind(storage)
    let r2Down = true
    storage.delete = (key: string) =>
      r2Down ? Promise.reject(new Error("R2 unavailable")) : realDelete(key)

    const orphan = repo.seed({
      id: "leaky-1",
      uploadId: "lu1",
      kind: "image",
      r2Key: "uploads/leak1",
      reportId: null,
      createdAt: new Date(now.getTime() - limits.orphanTtlMs - 60_000),
    })
    await storage.put(orphan.r2Key, Buffer.from([1, 2, 3]))

    const first = await runOrphanSweep({ repo, storage, limits, now: () => now, log: () => {} })
    expect(first.deleted).toBe(1)
    expect(repo.byId.has("leaky-1")).toBe(false)
    expect(first.leaked).toBe(repo.tombstones.size)
    expect(repo.tombstones.get("uploads/leak1")).toMatchObject({ mediaId: "leaky-1", attempts: 1 })
    expect(storage.get("uploads/leak1")).not.toBeNull()

    r2Down = false
    const second = await runOrphanSweep({ repo, storage, limits, now: () => now, log: () => {} })
    expect(second.retried).toBe(first.leaked)
    expect(second.reclaimed).toBe(first.leaked)
    expect(repo.tombstones.size).toBe(0)
    expect(storage.get("uploads/leak1")).toBeNull()
  })

  it("counts a key repeated inside ONE call as a single attempt (mirrors the real upsert)", async () => {
    const repo = new InMemoryWorkerRepo()

    await repo.recordLeakedObjects({
      mediaId: "dup-1",
      keys: ["uploads/dup", "uploads/dup", "uploads/other"],
    })
    expect(repo.tombstones.size).toBe(2)
    expect(repo.tombstones.get("uploads/dup")).toMatchObject({ mediaId: "dup-1", attempts: 1 })

    await repo.recordLeakedObjects({ mediaId: "dup-1", keys: ["uploads/dup"] })
    expect(repo.tombstones.get("uploads/dup")?.attempts).toBe(2)
  })

  it("stops retrying a tombstone at the attempt cap and reports it as permanent", async () => {
    const storage = new FakeStorage()
    const repo = new InMemoryWorkerRepo()
    const now = new Date("2026-06-01T12:00:00Z")
    storage.delete = () => Promise.reject(new Error("R2 unavailable"))
    await repo.recordLeakedObjects({ mediaId: "gone-1", keys: ["uploads/stuck"], error: "first" })

    const reports: unknown[] = []
    let lastRetried = 0
    for (let run = 0; run < LEAK_RETRY_MAX_ATTEMPTS; run++) {
      const res = await runOrphanSweep({
        repo,
        storage,
        limits,
        now: () => now,
        log: () => {},
        report: (e) => reports.push(e),
      })
      lastRetried = res.retried
    }
    expect(lastRetried).toBe(0)
    expect(repo.tombstones.get("uploads/stuck")?.attempts).toBe(LEAK_RETRY_MAX_ATTEMPTS)
    expect(reports.length).toBe(1)
  })
})

describe("orphan.sweep: legacy served-key adoption stops once drained", () => {
  it("adopts pre-0097 rows, then never scans again in this process", async () => {
    resetLegacyServedKeyAdoption()
    const storage = new FakeStorage()
    const repo = new InMemoryWorkerRepo()
    const now = new Date("2026-06-01T12:00:00Z")
    const old = new Date(now.getTime() - limits.orphanTtlMs - 60_000)

    const legacy = repo.seed({
      id: "legacy-1",
      uploadId: "u9",
      kind: "image",
      r2Key: "uploads/l1",
      reportId: "report-1",
      createdAt: old,
    })
    legacy.status = "ready"
    legacy.servedKey = null

    let scans = 0
    const counting = Object.assign(Object.create(Object.getPrototypeOf(repo) as object), repo, {
      adoptLegacyServedKeys: (olderThan: Date, limit: number) => {
        scans += 1
        return repo.adoptLegacyServedKeys(olderThan, limit)
      },
    }) as InMemoryWorkerRepo

    await runOrphanSweep({ repo: counting, storage, limits, now: () => now, log: () => {} })
    expect(scans).toBe(1)
    expect(legacy.servedKey).toBe("uploads/l1")

    await runOrphanSweep({ repo: counting, storage, limits, now: () => now, log: () => {} })
    expect(scans).toBe(2)

    await runOrphanSweep({ repo: counting, storage, limits, now: () => now, log: () => {} })
    expect(scans).toBe(2)
  })

  it("keeps scanning while a row still needs adoption", async () => {
    resetLegacyServedKeyAdoption()
    const storage = new FakeStorage()
    const repo = new InMemoryWorkerRepo()
    const now = new Date("2026-06-01T12:00:00Z")

    const pending = repo.seed({
      id: "legacy-2",
      uploadId: "u10",
      kind: "image",
      r2Key: "uploads/l2",
      reportId: "report-2",
      createdAt: new Date(now.getTime() - 60_000),
    })
    pending.status = "ready"
    pending.servedKey = null

    await runOrphanSweep({ repo, storage, limits, now: () => now, log: () => {} })
    expect(pending.servedKey).toBeNull()

    const later = new Date(now.getTime() + 30 * 60_000)
    await runOrphanSweep({ repo, storage, limits, now: () => later, log: () => {} })
    expect(pending.servedKey).toBe("uploads/l2")
  })
})

describe("chat.partition.maintenance", () => {
  function sqlCaptor(fail = false): { sql: import("@civfix/api/db").Sql; calls: string[] } {
    const calls: string[] = []
    const sql = {
      unsafe: (text: string) => {
        calls.push(text)
        return fail ? Promise.reject(new Error("db down")) : Promise.resolve([])
      },
    } as unknown as import("@civfix/api/db").Sql
    return { sql, calls }
  }

  it("F001: ensures a WINDOW (current + next 2 months) for BOTH chat_messages and dm_messages", async () => {
    const { sql, calls } = sqlCaptor()
    const res = await runPartitionMaintenance({
      sql,
      now: () => new Date("2026-06-15T00:00:00Z"),
      log: () => {},
    })
    expect(res.chat).toEqual([
      "chat_messages_2026_06",
      "chat_messages_2026_07",
      "chat_messages_2026_08",
    ])
    expect(res.dm).toEqual(["dm_messages_2026_06", "dm_messages_2026_07", "dm_messages_2026_08"])
    expect(calls.length).toBe(6)
    const june = calls.find((c) => c.includes("chat_messages_2026_06"))!
    expect(june).toContain("CREATE TABLE IF NOT EXISTS chat_messages_2026_06")
    expect(june).toContain("PARTITION OF chat_messages")
    expect(june).toContain("FROM ('2026-06-01 00:00:00+00') TO ('2026-07-01 00:00:00+00')")
    const dmAug = calls.find((c) => c.includes("dm_messages_2026_08"))!
    expect(dmAug).toContain("FROM ('2026-08-01 00:00:00+00') TO ('2026-09-01 00:00:00+00')")
  })

  it("honors monthsAhead and rolls the year across December", async () => {
    const { sql } = sqlCaptor()
    const res = await runPartitionMaintenance({
      sql,
      now: () => new Date("2026-12-10T00:00:00Z"),
      monthsAhead: 2,
      log: () => {},
    })
    expect(res.chat).toEqual([
      "chat_messages_2026_12",
      "chat_messages_2027_01",
      "chat_messages_2027_02",
    ])
  })

  it("F001: a SQL failure THROWS (loud, so a missing partition is not silent) and is reported", async () => {
    const { sql } = sqlCaptor(true)
    const reports: unknown[] = []
    await expect(
      runPartitionMaintenance({
        sql,
        now: () => new Date("2026-06-15T00:00:00Z"),
        log: () => {},
        report: (e) => reports.push(e),
      }),
    ).rejects.toThrow(/db down/)
    expect(reports.length).toBe(1)
  })
})

describe("media.stuck.sweep", () => {
  const ttl = limits.stuckMediaTtlMs
  const now = new Date("2026-06-01T12:00:00Z")
  const old = new Date(now.getTime() - ttl - 60_000)

  function makeJobsSpy(fail = false): {
    jobs: { enqueue: (n: string, d: unknown, o?: unknown) => Promise<string> }
    enqueued: { name: string; data: unknown; opts?: unknown }[]
  } {
    const enqueued: { name: string; data: unknown; opts?: unknown }[] = []
    const jobs = {
      enqueue: (name: string, data: unknown, opts?: unknown) => {
        if (fail) return Promise.reject(new Error("queue down"))
        enqueued.push({ name, data, opts })
        return Promise.resolve("job-id")
      },
    }
    return { jobs, enqueued }
  }

  function makeRepo(): InMemoryWorkerRepo {
    const repo = new InMemoryWorkerRepo()
    repo.now = () => now
    return repo
  }

  let storage: FakeStorage

  function run(
    repo: InMemoryWorkerRepo,
    jobs: { enqueue: (n: string, d: unknown, o?: unknown) => Promise<string> },
    overrides: Partial<typeof limits> = {},
    report?: (e: unknown) => void,
  ): ReturnType<typeof runStuckSweep> {
    storage = storage ?? new FakeStorage()
    return runStuckSweep({
      repo,
      jobs,
      storage,
      limits: { ...limits, ...overrides },
      now: () => now,
      log: () => {},
      ...(report ? { report } : {}),
    })
  }

  it("re-enqueues media.checks for FINALIZED rows stuck at validating past the TTL (singletonKey = uploadId)", async () => {
    const repo = makeRepo()
    const fresh = new Date(now.getTime() - 60_000)
    repo.seed({ id: "stuck-1", uploadId: "u1", kind: "image", r2Key: "uploads/s1", status: "validating", createdAt: old, finalizedAt: old })
    repo.seed({ id: "fresh-1", uploadId: "u2", kind: "image", r2Key: "uploads/s2", status: "validating", createdAt: fresh, finalizedAt: fresh })
    repo.seed({ id: "ready-1", uploadId: "u3", kind: "image", r2Key: "uploads/s3", status: "ready", createdAt: old, finalizedAt: old })

    const { jobs, enqueued } = makeJobsSpy()
    const res = await run(repo, jobs)

    expect(res).toEqual({ scanned: 1, requeued: 1, terminalized: 0, errors: 0 })
    expect(enqueued).toHaveLength(1)
    expect(enqueued[0]!.name).toBe(MEDIA_CHECKS_JOB)
    expect(enqueued[0]!.data).toEqual({
      mediaId: "stuck-1",
      uploadId: "u1",
      r2Key: "uploads/s1",
      kind: "image",
    })
    expect(enqueued[0]!.opts).toEqual({ singletonKey: "u1" })
  })

  it("never throws: an enqueue failure is counted + reported, the sweep continues", async () => {
    const repo = makeRepo()
    repo.seed({ id: "stuck-1", uploadId: "u1", kind: "image", r2Key: "uploads/s1", status: "validating", createdAt: old, finalizedAt: old })

    const reports: unknown[] = []
    const { jobs } = makeJobsSpy(true)
    const res = await run(repo, jobs, {}, (e) => reports.push(e))

    expect(res.scanned).toBe(1)
    expect(res.requeued).toBe(0)
    expect(res.errors).toBe(1)
    expect(reports.length).toBe(1)
  })

  it("F087b: NEVER-FINALIZED rows are out of scope - a presigned upload whose bytes never arrived is the orphan sweep's job", async () => {
    const repo = makeRepo()
    repo.seed({ id: "intent-1", uploadId: "u1", kind: "image", r2Key: "uploads/i1", status: "validating", createdAt: old, finalizedAt: null })
    repo.seed({ id: "stuck-1", uploadId: "u2", kind: "image", r2Key: "uploads/s1", status: "validating", createdAt: old, finalizedAt: old })

    const { jobs, enqueued } = makeJobsSpy()
    const res = await run(repo, jobs)

    expect(res.scanned).toBe(1)
    expect(enqueued.map((e) => (e.data as { mediaId: string }).mediaId)).toEqual(["stuck-1"])
    expect(repo.get("intent-1")!.stuckCheckCount).toBe(0)
  })

  it("F087d: staleness is measured from FINALIZE, not presign - a late-finalized asset gets a full TTL", async () => {
    const repo = makeRepo()
    repo.seed({ id: "late-1", uploadId: "u1", kind: "image", r2Key: "uploads/l1", status: "validating", createdAt: old, finalizedAt: new Date(now.getTime() - 60_000) })
    repo.seed({ id: "stuck-1", uploadId: "u2", kind: "image", r2Key: "uploads/s1", status: "validating", createdAt: old, finalizedAt: old })

    const { jobs, enqueued } = makeJobsSpy()
    const res = await run(repo, jobs)

    expect(res).toEqual({ scanned: 1, requeued: 1, terminalized: 0, errors: 0 })
    expect(enqueued.map((e) => (e.data as { mediaId: string }).mediaId)).toEqual(["stuck-1"])
    expect(repo.get("late-1")!.stuckCheckCount).toBe(0)
    expect(repo.get("late-1")!.status).toBe("validating")
  })

  it("F087d: the give-up budget starts at finalize too - a late-finalized asset is never terminalized early", async () => {
    const repo = makeRepo()
    repo.seed({ id: "late-1", uploadId: "u1", kind: "image", r2Key: "uploads/l1", status: "validating", createdAt: old, finalizedAt: new Date(now.getTime() - 60_000), stuckCheckCount: 9 })

    const { jobs } = makeJobsSpy()
    const res = await run(repo, jobs, { stuckSweepMaxAttempts: 3 })

    expect(res).toEqual({ scanned: 0, requeued: 0, terminalized: 0, errors: 0 })
    expect(repo.get("late-1")!.status).toBe("validating")
  })

  it("F087b: rotates - every pick is stamped, so an over-full batch serves never-checked rows first and cannot starve", async () => {
    const repo = makeRepo()
    for (const id of ["a", "b", "c"]) {
      repo.seed({ id, uploadId: `up-${id}`, kind: "image", r2Key: `uploads/${id}`, status: "validating", createdAt: old, finalizedAt: old })
    }
    repo.get("a")!.stuckCheckedAt = new Date(now.getTime() - 60_000)
    repo.get("b")!.stuckCheckedAt = new Date(now.getTime() - 120_000)

    const { jobs, enqueued } = makeJobsSpy()
    const res = await run(repo, jobs, { stuckSweepBatch: 2 })

    expect(res.scanned).toBe(2)
    expect(enqueued.map((e) => (e.data as { mediaId: string }).mediaId)).toEqual(["c", "b"])
    expect(repo.get("c")!.stuckCheckCount).toBe(1)
    expect(repo.get("b")!.stuckCheckCount).toBe(1)
    expect(repo.get("a")!.stuckCheckCount).toBe(0)
  })

  it("F087b: terminalizes a hopeless row after the attempt cap - status 'rejected', no further enqueue, ever", async () => {
    const repo = makeRepo()
    repo.seed({ id: "hopeless", uploadId: "u1", kind: "image", r2Key: "uploads/h1", status: "validating", createdAt: old, finalizedAt: old })

    const { jobs, enqueued } = makeJobsSpy()
    for (let i = 0; i < 3; i++) {
      const res = await run(repo, jobs, { stuckSweepMaxAttempts: 3 })
      expect(res).toEqual({ scanned: 1, requeued: 1, terminalized: 0, errors: 0 })
    }
    expect(enqueued).toHaveLength(3)
    expect(repo.get("hopeless")!.status).toBe("validating")

    const giveUp = await run(repo, jobs, { stuckSweepMaxAttempts: 3 })
    expect(giveUp).toEqual({ scanned: 1, requeued: 0, terminalized: 1, errors: 0 })
    expect(enqueued.filter((e) => e.name === MEDIA_CHECKS_JOB)).toHaveLength(3)
    expect(repo.get("hopeless")!.status).toBe("rejected")

    const reap = enqueued.filter((e) => e.name === MEDIA_UPLOAD_REAP_JOB)
    expect(reap).toHaveLength(1)
    expect(reap[0]!.data).toEqual({ mediaId: "hopeless", uploadId: "u1", r2Key: "uploads/h1" })
    expect(reap[0]!.opts).toEqual({ singletonKey: "u1", startAfter: uploadReapDelaySec() })

    const after = await run(repo, jobs, { stuckSweepMaxAttempts: 3 })
    expect(after).toEqual({ scanned: 0, requeued: 0, terminalized: 0, errors: 0 })
  })

  it("F087b: a terminalize failure is counted + reported, never thrown", async () => {
    const repo = makeRepo()
    repo.seed({ id: "hopeless", uploadId: "u1", kind: "image", r2Key: "uploads/h1", status: "validating", createdAt: old, finalizedAt: old, stuckCheckCount: 9 })
    repo.failApplyResult = new Error("db down")

    const reports: unknown[] = []
    const { jobs } = makeJobsSpy()
    const res = await run(repo, jobs, { stuckSweepMaxAttempts: 3 }, (e) => reports.push(e))

    expect(res).toEqual({ scanned: 1, requeued: 0, terminalized: 0, errors: 1 })
    expect(reports.length).toBe(1)
  })
  it("F087b: NEVER clobbers a terminal status — a row the worker finished mid-sweep is left alone", async () => {
    const repo = makeRepo()
    repo.seed({ id: "raced", uploadId: "u1", kind: "image", r2Key: "uploads/r1", status: "validating", createdAt: old, finalizedAt: old, stuckCheckCount: 9 })
    const { jobs } = makeJobsSpy()
    await repo.applyResult("raced", { status: "ready" })

    const res = await run(repo, jobs, { stuckSweepMaxAttempts: 3 })

    expect(res).toEqual({ scanned: 0, requeued: 0, terminalized: 0, errors: 0 })
    expect(repo.get("raced")!.status).toBe("ready")

    expect(await repo.terminalizeStuck("raced")).toBeNull()
    expect(repo.get("raced")!.status).toBe("ready")
  })

  it("F087b: a terminalized row's bytes are reclaimed, exactly like an in-band rejection", async () => {
    const repo = makeRepo()
    repo.seed({
      id: "hopeless", uploadId: "u1", kind: "image", r2Key: "uploads/h1", thumbKey: "uploads/h1.thumb",
      reportId: "report-1", status: "validating", createdAt: old, finalizedAt: old, stuckCheckCount: 9,
    })
    storage = new FakeStorage()
    await storage.put("uploads/h1", Buffer.from([1, 2, 3]))
    await storage.put("uploads/h1.thumb", Buffer.from([4]))

    const { jobs } = makeJobsSpy()
    const res = await run(repo, jobs, { stuckSweepMaxAttempts: 3 })

    expect(res.terminalized).toBe(1)
    expect(repo.get("hopeless")!.status).toBe("rejected")
    expect(await storage.head("uploads/h1")).toBeNull()
    expect(await storage.head("uploads/h1.thumb")).toBeNull()
  })
})
