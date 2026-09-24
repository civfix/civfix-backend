import { afterEach, describe, expect, it } from "vitest"
import {
  EXPORT_ABANDON_AFTER_MS,
  EXPORT_RUN_STALE_MS,
  makeHostExportService,
} from "../../src/services/host/export-service.js"
import {
  registerHostExportBuilder,
  resetHostExportBuildersForTests,
} from "../../src/services/host/export-builders.js"
import { makeDrizzleHostExportRepository } from "../../src/services/host/export-repository.drizzle.js"
import type {
  HostExportRecord,
  HostExportRepository,
} from "../../src/services/host/export-repository.js"
import type { Sql } from "../../src/db/client.js"
import { makeFakeSql } from "../helpers/fake-sql.js"

const EXPORT_ID = "00000000-0000-0000-0000-0000000000e1"
const EVENT = "00000000-0000-0000-0000-0000000000ee"
const HOST = "00000000-0000-0000-0000-0000000000aa"
const NOW = new Date("2026-02-05T12:00:00Z")

function record(overrides: Partial<HostExportRecord> = {}): HostExportRecord {
  return {
    id: EXPORT_ID,
    cleanupId: EVENT,
    organizationId: null,
    requestedBy: HOST,
    kind: "roster",
    filters: {},
    status: "queued",
    r2Key: null,
    rowCount: null,
    byteSize: null,
    truncated: false,
    errorCode: null,
    runToken: null,
    requestedAt: new Date("2026-02-05T11:59:00Z"),
    startedAt: null,
    completedAt: null,
    expiresAt: null,
    ...overrides,
  }
}

function harness(
  opts: {
    markReady?: HostExportRepository["markReady"]
    deleteFails?: boolean
    initial?: Partial<HostExportRecord>
    onDelete?: (key: string) => Promise<void>
  } = {},
) {
  registerHostExportBuilder("roster", {
    filename: () => "civfix-roster-test.csv",
    header: () => Promise.resolve(["a"]),
    provenance: () => Promise.resolve([]),
    rows: async function* () {
      yield ["1"]
    },
  })
  let current = record(opts.initial)
  const objects = new Set<string>()
  const repo: HostExportRepository = {
    create: () => Promise.resolve(current),
    findById: () => Promise.resolve(current),
    listForEvent: () => Promise.resolve([current]),
    listForOrganization: () => Promise.resolve([]),
    claimForRun: (_id, staleBefore) => {
      const reclaimable =
        current.status === "running" &&
        current.startedAt !== null &&
        current.startedAt < staleBefore
      if (current.status !== "queued" && !reclaimable) return Promise.resolve(null)
      current = { ...current, status: "running", startedAt: NOW, runToken: "run-1" }
      return Promise.resolve(current)
    },
    recordObjectKey: (
      _id,
      args: { r2Key: string; runToken: string | null; replaces?: string | null },
    ) => {
      if (current.status !== "running" || current.runToken !== args.runToken) {
        return Promise.resolve(false)
      }
      if (args.replaces !== undefined && current.r2Key !== args.replaces) {
        return Promise.resolve(false)
      }
      current = { ...current, r2Key: args.r2Key }
      return Promise.resolve(true)
    },
    markReady:
      opts.markReady ??
      ((_id, args) => {
        if (current.status !== "running" || current.runToken !== args.runToken) {
          return Promise.resolve(null)
        }
        const { runToken: _ignored, ...fields } = args
        current = { ...current, status: "ready", ...fields }
        return Promise.resolve(current)
      }),
    markFailed: (_id: string, errorCode: string, runToken?: string | null) => {
      const open = current.status === "queued" || current.status === "running"
      if (!open || (runToken !== undefined && current.runToken !== runToken)) {
        return Promise.resolve(false)
      }
      current = { ...current, status: "failed", errorCode }
      return Promise.resolve(true)
    },
    listExpired: () => Promise.resolve([]),
    markExpired: () => Promise.resolve(),
    listOrphaned: ({ staleBefore }) => {
      const orphaned =
        (current.status === "failed" && current.r2Key !== null) ||
        (current.status === "running" &&
          current.startedAt !== null &&
          current.startedAt < staleBefore) ||
        (current.status === "queued" && current.requestedAt < staleBefore)
      return Promise.resolve(orphaned ? [current] : [])
    },
    releaseObject: (target, errorCode) => {
      if (current.status !== target.status || current.runToken !== target.runToken) {
        return Promise.resolve(false)
      }
      current = {
        ...current,
        status: "failed",
        errorCode: current.errorCode ?? errorCode,
        r2Key: null,
      }
      return Promise.resolve(true)
    },
    deleteOlderThan: () => Promise.resolve(0),
  }
  let deleteFails = opts.deleteFails ?? false
  const service = makeHostExportService({
    repo,
    storage: {
      put: (key) => {
        objects.add(key)
        return Promise.resolve()
      },
      presignGet: (key) => Promise.resolve(`https://signed.example/${key}`),
      delete: async (key) => {
        if (deleteFails) throw new Error("r2 down")
        objects.delete(key)
        await opts.onDelete?.(key)
      },
    },
    config: { maxRows: 100, maxBytes: 1_000_000, ttlHours: 24 },
    now: () => NOW,
  })
  return {
    service,
    repo,
    objects,
    current: () => current,
    setCurrent: (patch: Partial<HostExportRecord>) => {
      current = { ...current, ...patch }
    },
    failDeletes: () => {
      deleteFails = true
    },
    storageRecovers: () => {
      deleteFails = false
    },
  }
}

afterEach(() => {
  resetHostExportBuildersForTests()
})

describe("host export objects never outlive a failed run", () => {
  it("deletes the object it wrote when the run fails after the upload", async () => {
    const h = harness({ markReady: () => Promise.reject(new Error("db blip")) })
    expect(await h.service.run(EXPORT_ID)).toEqual({ status: "failed" })
    expect(h.objects.size).toBe(0)
    expect(h.current().status).toBe("failed")
    expect(h.current().r2Key).toBeNull()
  })

  it("keeps the key on the failed row when that delete fails, so the reaper finishes it", async () => {
    const h = harness({
      markReady: () => Promise.reject(new Error("db blip")),
      deleteFails: true,
    })
    await h.service.run(EXPORT_ID)
    expect(h.objects.size).toBe(1)
    expect(h.current().r2Key).not.toBeNull()

    h.storageRecovers()
    await h.service.reap(10)
    expect(h.objects.size).toBe(0)
    expect(h.current().r2Key).toBeNull()
    expect(h.current().status).toBe("failed")
    expect(h.current().errorCode).toBe("build_failed")
  })

  it("reaps the object of a run that crashed and was never reclaimed", async () => {
    const key = "exports/host/2026/02/00000000-0000-0000-0000-0000000000e1.csv"
    const h = harness({
      initial: {
        status: "running",
        runToken: "run-crashed",
        r2Key: key,
        startedAt: new Date(NOW.getTime() - EXPORT_ABANDON_AFTER_MS - 1),
      },
    })
    h.objects.add(key)
    await h.service.reap(10)
    expect(h.objects.has(key)).toBe(false)
    expect(h.current().status).toBe("failed")
    expect(h.current().r2Key).toBeNull()
  })

  it("only lets the retention lane delete rows that no longer point at an object", async () => {
    const fake = makeFakeSql()
    const repo = makeDrizzleHostExportRepository(fake.sql as unknown as Sql)
    await repo.deleteOlderThan(new Date("2025-11-01T00:00:00Z"), 100)
    expect(fake.statements[0]!.sql).toMatch(/r2_key IS NULL/)
  })
})

describe("host export run superseded after its upload", () => {
  it("discards the object it uploaded and reports the run skipped", async () => {
    const h = harness({ markReady: () => Promise.resolve(null) })
    expect(await h.service.run(EXPORT_ID)).toEqual({ status: "skipped" })
    expect(h.objects.size).toBe(0)
  })
})

describe("host export requests that never started", () => {
  it("fails a queued export whose job never ran, instead of showing it queued forever", async () => {
    const h = harness({
      initial: { requestedAt: new Date(NOW.getTime() - EXPORT_ABANDON_AFTER_MS - 1) },
    })
    await h.service.reap(10)
    expect(h.current().status).toBe("failed")
    expect(h.current().errorCode).toBe("not_started")
  })

  it("leaves a freshly queued export alone", async () => {
    const h = harness()
    await h.service.reap(10)
    expect(h.current().status).toBe("queued")
  })
})

describe("host export download", () => {
  it("refuses a ready export whose object has expired but was not reaped yet", async () => {
    const h = harness()
    await expect(
      h.service.downloadUrl(
        record({
          status: "ready",
          r2Key: "exports/host/2026/02/x.csv",
          expiresAt: new Date(NOW.getTime() - 1000),
        }),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT", message: "That export has expired." })
  })
})

describe("the reaper fences a stale run before deleting its object", () => {
  it("never leaves a ready row pointing at an object it deleted", async () => {
    const key = "exports/host/2026/02/run-live/00000000-0000-0000-0000-0000000000e1.csv"
    let lateReady: HostExportRecord | null | undefined
    const h: ReturnType<typeof harness> = harness({
      initial: {
        status: "running",
        runToken: "run-live",
        r2Key: key,
        startedAt: new Date(NOW.getTime() - EXPORT_ABANDON_AFTER_MS - 1),
      },
      onDelete: async () => {
        lateReady = await h.repo.markReady(EXPORT_ID, {
          r2Key: key,
          rowCount: 1,
          byteSize: 2,
          truncated: false,
          expiresAt: new Date(NOW.getTime() + 3_600_000),
          runToken: "run-live",
        })
      },
    })
    h.objects.add(key)

    await h.service.reap(10)

    expect(lateReady).toBeNull()
    expect(h.objects.has(key)).toBe(false)
    expect(h.current().status).toBe("failed")
    expect(h.current().r2Key).toBeNull()
  })

  it("leaves the key on the fenced row when the delete fails, for the next pass", async () => {
    const key = "exports/host/2026/02/run-crashed/00000000-0000-0000-0000-0000000000e1.csv"
    const h = harness({
      initial: {
        status: "running",
        runToken: "run-crashed",
        r2Key: key,
        startedAt: new Date(NOW.getTime() - EXPORT_ABANDON_AFTER_MS - 1),
      },
      deleteFails: true,
    })
    h.objects.add(key)

    await h.service.reap(10)
    expect(h.current().status).toBe("failed")
    expect(h.current().r2Key).toBe(key)

    h.storageRecovers()
    await h.service.reap(10)
    expect(h.objects.has(key)).toBe(false)
    expect(h.current().r2Key).toBeNull()
  })
})

describe("a re-claimed run never loses the previous run's object", () => {
  const OLD_KEY = "exports/host/2026/02/run-crashed/00000000-0000-0000-0000-0000000000e1.csv"
  const staleRun = {
    status: "running" as const,
    runToken: "run-crashed",
    r2Key: OLD_KEY,
    startedAt: new Date(NOW.getTime() - EXPORT_RUN_STALE_MS - 1),
  }

  it("deletes the object a crashed run uploaded before recording its own", async () => {
    const h = harness({ initial: staleRun })
    h.objects.add(OLD_KEY)

    expect(await h.service.run(EXPORT_ID)).toEqual({ status: "ready" })

    expect(h.objects.has(OLD_KEY)).toBe(false)
    expect(h.objects.size).toBe(1)
    expect(h.current().r2Key).not.toBe(OLD_KEY)
    expect(h.objects.has(h.current().r2Key ?? "")).toBe(true)
  })

  it("fails the run and keeps the old key on the row when that delete fails", async () => {
    const h = harness({ initial: staleRun, deleteFails: true })
    h.objects.add(OLD_KEY)

    expect(await h.service.run(EXPORT_ID)).toEqual({ status: "failed" })

    expect(h.current().status).toBe("failed")
    expect(h.current().r2Key).toBe(OLD_KEY)
    expect([...h.objects]).toEqual([OLD_KEY])
  })

  it("refuses to record a key over a different one it was not told to replace", async () => {
    const fake = makeFakeSql()
    const repo = makeDrizzleHostExportRepository(fake.sql as unknown as Sql)
    await repo.recordObjectKey(EXPORT_ID, {
      r2Key: "exports/host/new.csv",
      runToken: "run-1",
      replaces: OLD_KEY,
    })
    const stmt = fake.statements[0]!
    expect(stmt.sql).toMatch(/r2_key IS NOT DISTINCT FROM \?/)
    expect(stmt.values).toContain(OLD_KEY)
  })
})

describe("a superseded run cannot fail the live run", () => {
  it("guards the failure write with the run token", async () => {
    const fake = makeFakeSql()
    const repo = makeDrizzleHostExportRepository(fake.sql as unknown as Sql)
    await repo.markFailed(EXPORT_ID, "build_failed", "run-1")
    const stmt = fake.statements[0]!
    expect(stmt.sql).toMatch(/run_token IS NOT DISTINCT FROM \?/)
    expect(stmt.values).toContain("run-1")
  })

  it("leaves the newer claim running when the older run's build throws", async () => {
    const h = harness()
    resetHostExportBuildersForTests()
    registerHostExportBuilder("roster", {
      filename: () => "civfix-roster-test.csv",
      header: () => Promise.resolve(["a"]),
      provenance: () => Promise.resolve([]),
      // eslint-disable-next-line require-yield
      rows: async function* () {
        h.setCurrent({ runToken: "run-newer" })
        throw new Error("builder blew up")
      },
    })

    expect(await h.service.run(EXPORT_ID)).toEqual({ status: "failed" })

    expect(h.current().status).toBe("running")
    expect(h.current().runToken).toBe("run-newer")
  })
})
