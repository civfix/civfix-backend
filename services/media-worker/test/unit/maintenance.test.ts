/**
 * Orphan sweep + chat-partition maintenance unit tests (offline; no DB).
 *
 * orphan-sweep uses the in-memory repo + FakeStorage; partition-maintenance's date math is asserted via
 * the shared ensureNextMonthChatPartition with an injected SQL spy (no real Postgres).
 */

import { describe, expect, it } from "vitest"
import { FakeStorage } from "@civfix/shared/fakes"
import { loadLimits } from "../../src/config.js"
import { runOrphanSweep } from "../../src/jobs/orphan-sweep.js"
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
    expect(calls.length).toBe(1)
    expect(calls[0]).toContain("CREATE TABLE IF NOT EXISTS chat_messages_2026_07")
    expect(calls[0]).toContain("PARTITION OF chat_messages")
    expect(calls[0]).toContain("FROM ('2026-07-01 00:00:00+00') TO ('2026-08-01 00:00:00+00')")
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
