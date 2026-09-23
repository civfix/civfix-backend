import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { csvCell, csvProvenanceRow, csvRow } from "../../src/services/host/export-csv.js"
import { makeHostExportService, toHostExportDTO } from "../../src/services/host/export-service.js"
import {
  hostExportBuilder,
  registerHostExportBuilder,
  resetHostExportBuildersForTests,
} from "../../src/services/host/export-builders.js"
import { registerEventExportBuilders } from "../../src/services/host/host-export-builders.js"
import type {
  HostExportRecord,
  HostExportRepository,
} from "../../src/services/host/export-repository.drizzle.js"

describe("csv cells", () => {
  it("quotes commas, quotes and newlines", () => {
    expect(csvCell("a,b")).toBe('"a,b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"')
  })

  it("prefixes formula-injection cells", () => {
    expect(csvCell('=HYPERLINK("https://evil.example")')).toContain("'=")
    expect(csvCell("+1")).toBe(`"'+1"`)
    expect(csvCell("-1")).toBe(`"'-1"`)
    expect(csvCell("@x")).toBe(`"'@x"`)
    expect(csvCell("\tx")).toBe(`"'\tx"`)
  })

  it("renders empty for null and undefined", () => {
    expect(csvCell(null)).toBe("")
    expect(csvCell(undefined)).toBe("")
  })

  it("writes rows and provenance lines", () => {
    expect(csvRow(["a", "b"])).toBe('"a","b"\n')
    expect(csvProvenanceRow("note")).toBe('"# note"\n')
  })
})

const EXPORT_ID = "00000000-0000-0000-0000-0000000000e1"
const EVENT = "00000000-0000-0000-0000-0000000000ee"
const HOST = "00000000-0000-0000-0000-0000000000aa"

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
    requestedAt: new Date("2026-02-01T00:00:00Z"),
    startedAt: null,
    completedAt: null,
    expiresAt: null,
    ...overrides,
  }
}

function harness(
  rows: string[][],
  config = { maxRows: 50_000, maxBytes: 16 * 1024 * 1024, ttlHours: 24 },
  authorize?: (record: HostExportRecord) => Promise<void>,
) {
  resetHostExportBuildersForTests()
  registerHostExportBuilder("roster", {
    filename: () => "civfix-roster-test.csv",
    header: () => Promise.resolve(["a", "b"]),
    provenance: () => Promise.resolve(["member email is never included", "k=5 note"]),
    rows: async function* () {
      for (const row of rows) yield row
    },
  })
  let current = record()
  const claims: Date[] = []
  const puts: Array<{ key: string; body: Buffer; meta: unknown }> = []
  const deletes: string[] = []
  const repo: HostExportRepository = {
    create: () => Promise.resolve(current),
    findById: () => Promise.resolve(current),
    listForEvent: () => Promise.resolve([current]),
    listForOrganization: () => Promise.resolve(current.organizationId === null ? [] : [current]),
    claimForRun: (_id, staleBefore) => {
      const reclaimable =
        current.status === "running" &&
        current.startedAt !== null &&
        current.startedAt < staleBefore
      if (current.status !== "queued" && !reclaimable) return Promise.resolve(null)
      claims.push(staleBefore)
      current = {
        ...current,
        status: "running",
        startedAt: new Date(),
        runToken: `run-${claims.length}`,
      }
      return Promise.resolve(current)
    },
    recordObjectKey: (_id, args) => {
      if (current.status !== "running" || args.runToken !== current.runToken) {
        return Promise.resolve(false)
      }
      current = { ...current, r2Key: args.r2Key }
      return Promise.resolve(true)
    },
    markReady: (_id, args) => {
      if (args.runToken !== current.runToken) return Promise.resolve(null)
      const { runToken: _ignored, ...fields } = args
      current = { ...current, status: "ready", ...fields }
      return Promise.resolve(current)
    },
    markFailed: (_id, errorCode) => {
      current = { ...current, status: "failed", errorCode }
      return Promise.resolve()
    },
    listExpired: () => Promise.resolve(current.status === "ready" ? [current] : []),
    markExpired: () => {
      current = { ...current, status: "expired", r2Key: null }
      return Promise.resolve()
    },
    listOrphaned: () => Promise.resolve([]),
    releaseObject: () => Promise.resolve(false),
    deleteOlderThan: () => Promise.resolve(0),
  }
  const service = makeHostExportService({
    repo,
    storage: {
      put: (key, body, meta) => {
        puts.push({ key, body: Buffer.from(body), meta })
        return Promise.resolve()
      },
      presignGet: (key, ttl, opts) =>
        Promise.resolve(`https://signed.example/${key}?ttl=${ttl}&signed=${opts?.forceSigned}`),
      delete: (key) => {
        deletes.push(key)
        return Promise.resolve()
      },
    },
    config,
    ...(authorize !== undefined ? { authorize } : {}),
    now: () => new Date("2026-02-05T12:00:00Z"),
  })
  return {
    service,
    puts,
    deletes,
    claims,
    current: () => current,
    setCurrent: (patch: Partial<HostExportRecord>) => {
      current = { ...current, ...patch }
    },
  }
}

describe("host export build", () => {
  it("writes provenance, a header and every row under a dated key", async () => {
    const h = harness([
      ["1", "Alex"],
      ["2", "Sam"],
    ])
    expect(await h.service.run(EXPORT_ID)).toEqual({ status: "ready" })
    const put = h.puts[0]!
    expect(put.key).toBe("exports/host/2026/02/00000000-0000-0000-0000-0000000000e1.csv")
    expect(put.meta).toMatchObject({ contentType: "text/csv; charset=utf-8" })
    expect(
      String(put.meta && (put.meta as { contentDisposition: string }).contentDisposition),
    ).toContain("attachment;")
    const text = put.body.toString("utf8")
    expect(text).toContain("# member email is never included")
    expect(text).toContain("# k=5 note")
    expect(text).toContain('"a","b"\n')
    expect(text).toContain('"1","Alex"\n')
    expect(h.current().rowCount).toBe(2)
    expect(h.current().truncated).toBe(false)
  })

  it("truncates at the row cap and says so in the file", async () => {
    const h = harness(
      Array.from({ length: 10 }, (_, i) => [String(i), "x"]),
      { maxRows: 3, maxBytes: 16 * 1024 * 1024, ttlHours: 24 },
    )
    await h.service.run(EXPORT_ID)
    expect(h.current().rowCount).toBe(3)
    expect(h.current().truncated).toBe(true)
    expect(h.puts[0]!.body.toString("utf8")).toContain("# truncated:")
  })

  it("truncates at the byte budget", async () => {
    const h = harness(
      Array.from({ length: 1000 }, (_, i) => [String(i), "y".repeat(100)]),
      { maxRows: 50_000, maxBytes: 2000, ttlHours: 24 },
    )
    await h.service.run(EXPORT_ID)
    expect(h.current().truncated).toBe(true)
  })

  it("escapes an injected formula in a data cell", async () => {
    const h = harness([["1", '=HYPERLINK("https://evil.example","x")']])
    await h.service.run(EXPORT_ID)
    expect(h.puts[0]!.body.toString("utf8")).toContain("'=HYPERLINK")
  })

  it("is idempotent: a second run does not re-claim", async () => {
    const h = harness([["1", "x"]])
    await h.service.run(EXPORT_ID)
    expect(await h.service.run(EXPORT_ID)).toEqual({ status: "skipped" })
    expect(h.puts).toHaveLength(1)
  })

  it("mints a SHORT forceSigned download url", async () => {
    const h = harness([["1", "x"]])
    await h.service.run(EXPORT_ID)
    const link = await h.service.downloadUrl(h.current())
    expect(link.url).toContain("ttl=300")
    expect(link.url).toContain("signed=true")
    expect(link.filename).toBe("00000000-0000-0000-0000-0000000000e1.csv")
  })

  it("refuses to mint a url for an export that is not ready", async () => {
    const h = harness([["1", "x"]])
    await expect(h.service.downloadUrl(record())).rejects.toMatchObject({ code: "CONFLICT" })
  })

  it("reaps the object BEFORE the row", async () => {
    const h = harness([["1", "x"]])
    await h.service.run(EXPORT_ID)
    const result = await h.service.reap(10)
    expect(result.reaped).toBe(1)
    expect(h.deletes).toHaveLength(1)
    expect(h.current().status).toBe("expired")
    expect(h.current().r2Key).toBeNull()
  })

  it("leaves the row ready when the object delete fails", async () => {
    const h = harness([["1", "x"]])
    await h.service.run(EXPORT_ID)
    const service = makeHostExportService({
      repo: {
        ...({} as HostExportRepository),
        listExpired: () => Promise.resolve([h.current()]),
        markExpired: () => Promise.reject(new Error("should not be called")),
        listOrphaned: () => Promise.resolve([]),
      } as HostExportRepository,
      storage: {
        put: () => Promise.resolve(),
        presignGet: () => Promise.resolve("x"),
        delete: () => Promise.reject(new Error("r2 down")),
      },
      config: { maxRows: 1, maxBytes: 1, ttlHours: 1 },
      now: () => new Date("2026-02-05T12:00:00Z"),
    })
    await expect(service.reap(10)).resolves.toEqual({ reaped: 0 })
  })

  it("maps a record to its DTO without exposing the storage key", () => {
    const dto = toHostExportDTO(record({ status: "ready", r2Key: "exports/host/x.csv" }))
    expect(JSON.stringify(dto)).not.toContain("exports/host")
  })
})

describe("roster export query source", () => {
  it("never names a member's email or phone column", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../../src/services/host/host-export-builders.ts", import.meta.url)),
      "utf8",
    )
    const rosterQuery = source.slice(
      source.indexOf("async function* rosterRows"),
      source.indexOf("async function* checkinRows"),
    )
    expect(rosterQuery.length).toBeGreaterThan(100)
    expect(rosterQuery).not.toMatch(/u\.email/)
    expect(rosterQuery).not.toMatch(/u\.phone/)
    expect(rosterQuery).not.toMatch(/users\.email/)
    expect(rosterQuery).not.toMatch(/users\.phone/)
    expect(rosterQuery).toMatch(/g\.email AS guest_email/)
  })

  /**
   * The CSV is the LAST place a host can hold guest contact after `EventGuestsBlock`, and it is the
   * only artefact that leaves the platform. The header and the provenance block are the promise the
   * file makes about that, so they are pinned here rather than left to a DB-backed test.
   */
  it("carries guest_email and guest_phone on the roster, with the scrub caveat written on the file", async () => {
    resetHostExportBuildersForTests()
    registerEventExportBuilders(() => {
      throw new Error("no SQL: header and provenance must not touch the database")
    })
    const ctx = {
      exportId: "11111111-1111-4111-8111-111111111111",
      cleanupId: "22222222-2222-4222-8222-222222222222",
      organizationId: null,
      requestedBy: "33333333-3333-4333-8333-333333333333",
      filters: {},
      now: new Date("2026-02-05T12:00:00Z"),
    }

    const roster = hostExportBuilder("roster")
    const header = await roster.header(ctx)
    expect(header).toContain("guest_email")
    expect(header).toContain("guest_phone")
    expect(header).toContain("attendee_kind")
    expect((await roster.provenance(ctx)).join(" ")).toContain(
      "guest contact is blank once the 30-day retention scrub has run",
    )

    // The check-in export is a different capability's artefact and must NOT carry contact.
    const checkins = await hostExportBuilder("checkins").header(ctx)
    expect(checkins).not.toContain("guest_email")
    expect(checkins).not.toContain("guest_phone")

    resetHostExportBuildersForTests()
  })
})

describe("host export run guards", () => {
  it("re-checks the requester's capability inside the job and fails a revoked export", async () => {
    const h = harness([["1", "Alex"]], { maxRows: 10, maxBytes: 1024, ttlHours: 24 }, () =>
      Promise.reject(new Error("forbidden")),
    )
    expect(await h.service.run(EXPORT_ID)).toEqual({ status: "failed" })
    expect(h.current().status).toBe("failed")
    expect(h.current().errorCode).toBe("forbidden")
    expect(h.puts).toHaveLength(0)
  })

  it("reclaims a run a crash left running past the stale window", async () => {
    const h = harness([["1", "Alex"]])
    h.setCurrent({
      status: "running",
      startedAt: new Date("2026-02-05T11:00:00Z"),
    })
    expect(await h.service.run(EXPORT_ID)).toEqual({ status: "ready" })
    expect(h.claims[0]?.toISOString()).toBe("2026-02-05T11:50:00.000Z")
  })

  it("leaves a run that is still fresh alone", async () => {
    const h = harness([["1", "Alex"]])
    h.setCurrent({
      status: "running",
      startedAt: new Date("2026-02-05T11:59:00Z"),
    })
    expect(await h.service.run(EXPORT_ID)).toEqual({ status: "skipped" })
  })
})

describe("host export claim token", () => {
  it("discards its own object when a newer claim superseded this run", async () => {
    const h = harness([["1", "Alex"]])
    resetHostExportBuildersForTests()
    registerHostExportBuilder("roster", {
      filename: () => "civfix-roster-test.csv",
      header: () => Promise.resolve(["a", "b"]),
      provenance: () => Promise.resolve([]),
      rows: async function* () {
        h.setCurrent({ runToken: "run-stolen" })
        yield ["1", "Alex"]
      },
    })

    expect(await h.service.run(EXPORT_ID)).toEqual({ status: "skipped" })
    expect(h.current().status).toBe("running")
    expect(h.current().r2Key).toBeNull()
    expect(h.puts).toHaveLength(0)
    expect(h.deletes).toEqual([])
  })
})
