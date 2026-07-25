/**
 * Orphan sweep + chat-partition maintenance unit tests (offline; no DB).
 *
 * orphan-sweep uses the in-memory repo + FakeStorage; partition-maintenance's date math is asserted via
 * the shared ensureNextMonthChatPartition with an injected SQL spy (no real Postgres).
 */

import { describe, expect, it } from "vitest"
import { FakeStorage } from "@civfix/shared/fakes"
import { loadLimits } from "../../src/config.js"
import { LEAK_RETRY_MAX_ATTEMPTS, runOrphanSweep } from "../../src/jobs/orphan-sweep.js"
import { runPartitionMaintenance } from "../../src/jobs/partition-maintenance.js"
import { InMemoryWorkerRepo } from "../helpers/in-memory-repo.js"

const limits = loadLimits({})

describe("orphan.sweep", () => {
  it("deletes only never-attached rows older than the TTL, removing their objects", async () => {
    const storage = new FakeStorage()
    const repo = new InMemoryWorkerRepo()
    const now = new Date("2026-06-01T12:00:00Z")
    const old = new Date(now.getTime() - limits.orphanTtlMs - 60_000) // older than TTL
    const fresh = new Date(now.getTime() - 60_000) // within TTL

    // Orphan (old, no report) -> swept.
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

    // Attached (old, but has a report) -> kept.
    repo.seed({
      id: "attached-1",
      uploadId: "u2",
      kind: "image",
      r2Key: "uploads/a1",
      reportId: "report-123",
      createdAt: old,
    })
    // Fresh orphan (no report but within TTL) -> kept.
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

    // Orphan row + its objects gone.
    expect(repo.byId.has("orphan-1")).toBe(false)
    expect(storage.get("uploads/o1")).toBeNull()
    expect(storage.get("thumbs/uploads/o1.jpg")).toBeNull()
    expect(storage.get("processed/uploads/o1.img")).toBeNull()

    // The other two remain.
    expect(repo.byId.has("attached-1")).toBe(true)
    expect(repo.byId.has("fresh-1")).toBe(true)
  })

  /**
   * REGRESSION (blocker): the orphan predicate was `report_id IS NULL` alone, and EVERY non-report lane
   * leaves report_id NULL. Combined with the 6h TTL and the drain loop, the first sweep after deploy
   * would have deleted every user avatar, every social-post photo and every chat/DM attachment older
   * than 6h — rows AND R2 objects, with avatar_media_id silently NULLed by its ON DELETE SET NULL FK.
   *
   * One row per binding lane, all old enough to be swept, none of them orphans.
   */
  it("never reaps a BOUND row: chat/DM, post, avatar and verification lanes all survive", async () => {
    const storage = new FakeStorage()
    const repo = new InMemoryWorkerRepo()
    const now = new Date("2026-06-01T12:00:00Z")
    const old = new Date(now.getTime() - limits.orphanTtlMs - 60_000)

    const bound = [
      // FORWARD: chat + DM attachment (message-attachments.drizzle.ts stamps chat_message_id and its
      // attach guard REQUIRES report_id IS NULL, so every one of these matched the old predicate).
      { id: "chat-1", uploadId: "cu", r2Key: "uploads/chat1", chatMessageId: "msg-1" },
      // FORWARD: social-feed post media (post_id + purpose='post').
      { id: "post-1", uploadId: "pu", r2Key: "uploads/post1", postId: "post-abc", purpose: "post" },
      // OUT-OF-BAND: verification document, referenced only from user_verification.documents jsonb.
      { id: "verif-1", uploadId: "vu", r2Key: "uploads/verif1", purpose: "verification" },
      // REVERSE: users.avatar_media_id / chat_groups.avatar_media_id point AT the row (seeded below).
      { id: "avatar-1", uploadId: "au", r2Key: "uploads/avatar1" },
    ] as const
    for (const row of bound) {
      repo.seed({ ...row, kind: "image", reportId: null, createdAt: old })
      await storage.put(row.r2Key, Buffer.from([1]))
    }
    repo.seedAvatarReference("avatar-1")

    // A genuine orphan alongside them, so a predicate that simply matched nothing would not pass.
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

    // Every bound row keeps BOTH its database row and its bytes.
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

    // 25 orphans against a page size of 10. The old sweep reaped ONE page per hourly run, against a
    // presign rate limit that creates orders of magnitude more rows per day — so the backlog could
    // only ever grow. The sweep now keeps paging while a page comes back full.
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
    repo.deleteById = () => Promise.reject(new Error("delete failed"))

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

  /**
   * B35: the row is deleted BEFORE its objects, so a failed storage delete is the one leak nothing could
   * rediscover. media_reap_tombstones (0057) is that memory — assert the whole round trip, because a
   * tombstone that is written but never retried is indistinguishable from the bug it replaced.
   */
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
    // The row IS reaped (that half succeeded); every derived key leaked and was tombstoned.
    expect(first.deleted).toBe(1)
    expect(repo.byId.has("leaky-1")).toBe(false)
    expect(first.leaked).toBe(repo.tombstones.size)
    expect(repo.tombstones.get("uploads/leak1")).toMatchObject({ mediaId: "leaky-1", attempts: 1 })
    // The bytes really are still there — this is the leak the tombstone exists to close.
    expect(storage.get("uploads/leak1")).not.toBeNull()

    r2Down = false
    const second = await runOrphanSweep({ repo, storage, limits, now: () => now, log: () => {} })
    expect(second.retried).toBe(first.leaked)
    expect(second.reclaimed).toBe(first.leaked)
    expect(repo.tombstones.size).toBe(0)
    expect(storage.get("uploads/leak1")).toBeNull()
  })

  /**
   * The real recordLeakedObjects is ONE multi-row upsert, so it collapses `keys` to a Set first: Postgres
   * aborts a statement that tries to affect the same row twice (21000), and a throw there makes the leak
   * permanent (the media row is already gone). The fake has to agree, or a duplicate key would bump
   * attempts twice here and once in production — retiring the key from the retry range a run early.
   */
  it("counts a key repeated inside ONE call as a single attempt (mirrors the real upsert)", async () => {
    const repo = new InMemoryWorkerRepo()

    await repo.recordLeakedObjects({
      mediaId: "dup-1",
      keys: ["uploads/dup", "uploads/dup", "uploads/other"],
    })
    expect(repo.tombstones.size).toBe(2)
    expect(repo.tombstones.get("uploads/dup")).toMatchObject({ mediaId: "dup-1", attempts: 1 })

    // A SEPARATE call is a real retry, so it does bump.
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
    // Attempts start at 1, so the runs that still retry are (cap - 1); one extra run proves it stopped.
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
    // Kept, not deleted: the row is the operator-visible record that a manual bucket cleanup is owed.
    expect(repo.tombstones.get("uploads/stuck")?.attempts).toBe(LEAK_RETRY_MAX_ATTEMPTS)
    // Exactly one "gave up" report, on the attempt that reached the cap.
    expect(reports.length).toBe(1)
  })
})

describe("chat.partition.maintenance", () => {
  it("issues CREATE TABLE IF NOT EXISTS for NEXT month's partition with correct bounds", async () => {
    const calls: string[] = []
    // Minimal SQL spy: only `.unsafe(text)` is used by ensureNextMonthChatPartition.
    const sqlSpy = {
      unsafe: (text: string) => {
        calls.push(text)
        return Promise.resolve([])
      },
    } as unknown as import("@civfix/api/db").Sql

    // From 2026-06-15, next month is 2026-07, bounds [2026-07-01, 2026-08-01).
    const table = await runPartitionMaintenance({
      sql: sqlSpy,
      now: () => new Date("2026-06-15T00:00:00Z"),
      log: () => {},
    })
    expect(table).toBe("chat_messages_2026_07")
    // The maintenance now ensures BOTH the chat_messages AND the dm_messages partition for next month, so
    // it issues two CREATE TABLE statements (one per partitioned table).
    expect(calls.length).toBe(2)
    const chatCall = calls.find((c) => c.includes("chat_messages_2026_07"))!
    expect(chatCall).toContain("CREATE TABLE IF NOT EXISTS chat_messages_2026_07")
    expect(chatCall).toContain("PARTITION OF chat_messages")
    expect(chatCall).toContain("FROM ('2026-07-01 00:00:00+00') TO ('2026-08-01 00:00:00+00')")
    // And the dm_messages partition with the same bounds.
    const dmCall = calls.find((c) => c.includes("dm_messages_2026_07"))!
    expect(dmCall).toContain("CREATE TABLE IF NOT EXISTS dm_messages_2026_07")
    expect(dmCall).toContain("PARTITION OF dm_messages")
    expect(dmCall).toContain("FROM ('2026-07-01 00:00:00+00') TO ('2026-08-01 00:00:00+00')")
  })

  it("rolls the year correctly: December -> next-January partition", async () => {
    const calls: string[] = []
    const sqlSpy = {
      unsafe: (text: string) => {
        calls.push(text)
        return Promise.resolve([])
      },
    } as unknown as import("@civfix/api/db").Sql
    const table = await runPartitionMaintenance({
      sql: sqlSpy,
      now: () => new Date("2026-12-10T00:00:00Z"),
      log: () => {},
    })
    expect(table).toBe("chat_messages_2027_01")
    expect(calls[0]).toContain("FROM ('2027-01-01 00:00:00+00') TO ('2027-02-01 00:00:00+00')")
  })

  it("never throws: a SQL failure returns null", async () => {
    const sqlSpy = {
      unsafe: () => Promise.reject(new Error("db down")),
    } as unknown as import("@civfix/api/db").Sql
    const reports: unknown[] = []
    const table = await runPartitionMaintenance({
      sql: sqlSpy,
      now: () => new Date("2026-06-15T00:00:00Z"),
      log: () => {},
      report: (e) => reports.push(e),
    })
    expect(table).toBeNull()
    expect(reports.length).toBe(1)
  })
})
