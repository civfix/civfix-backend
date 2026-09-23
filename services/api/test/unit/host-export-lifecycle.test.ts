import { afterEach, describe, expect, it } from "vitest"
import {
  EXPORT_ABANDON_AFTER_MS,
  makeHostExportService,
} from "../../src/services/host/export-service.js"
import {
  registerHostExportBuilder,
  resetHostExportBuildersForTests,
} from "../../src/services/host/export-builders.js"
import {
  makeDrizzleHostExportRepository,
  type HostExportRecord,
  type HostExportRepository,
} from "../../src/services/host/export-repository.drizzle.js"
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
    claimForRun: () => {
      if (current.status !== "queued") return Promise.resolve(null)
      current = { ...current, status: "running", startedAt: NOW, runToken: "run-1" }
      return Promise.resolve(current)
    },
    recordObjectKey: (_id, args) => {
      if (current.status !== "running" || current.runToken !== args.runToken) {
        return Promise.resolve(false)
      }
      current = { ...current, r2Key: args.r2Key }
      return Promise.resolve(true)
    },
    markReady:
      opts.markReady ??
      ((_id, args) => {
        const { runToken: _ignored, ...fields } = args
        current = { ...current, status: "ready", ...fields }
        return Promise.resolve(current)
      }),
    markFailed: (_id, errorCode) => {
      current = { ...current, status: "failed", errorCode }
      return Promise.resolve()
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
      delete: (key) => {
        if (deleteFails) return Promise.reject(new Error("r2 down"))
        objects.delete(key)
        return Promise.resolve()
      },
    },
    config: { maxRows: 100, maxBytes: 1_000_000, ttlHours: 24 },
    now: () => NOW,
  })
  return {
    service,
    objects,
    current: () => current,
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
