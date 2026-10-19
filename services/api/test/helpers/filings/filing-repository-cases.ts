/**
 * The FilingRepository cases that run against both InMemoryFilingRepository (test/unit) and
 * makeDrizzleFilingRepository (test/integration), so the twin cannot drift from the real repository.
 * Each implementation supplies a FilingWorld: a fresh repository plus raw seeding and reads that bypass it.
 */

import { randomUUID } from "node:crypto"
import { beforeEach, describe, expect, it } from "vitest"
import type { WriteAuditInput } from "../../../src/services/admin/audit.js"
import type { FilingRepository } from "../../../src/services/filings/filing-repository.js"
import type {
  CreateFilingResult,
  FilingChannel,
  FilingEvidenceKind,
  FilingRecord,
  FilingStatus,
} from "../../../src/services/filings/filing-types.js"

export type FilingSeedRow = Omit<FilingRecord, "id" | "jurisdictionName">

export interface SeedFiling extends Partial<FilingSeedRow> {
  reportId: string
  status: FilingStatus
}

export interface SeedReport {
  geoid?: string | null
  status?: string
  title?: string | null
  deletedAt?: Date | null
  verificationVerdict?: "approved" | "rejected" | null
}

export interface WorldReport {
  status: string
  deletedAt: Date | null
  verificationVerdict: string | null
}

export interface WorldTimelineRow {
  kind: string | null
  status: string
  note: string | null
  actorId: string | null
}

export interface WorldAuditRow {
  action: string
  actorId: string | null
  target: string | null
}

export interface FilingWorld {
  kind: "memory" | "pg"
  repo: FilingRepository
  /** `G`, named "City of Los Angeles", and `G2`. */
  G: string
  G2: string
  /** An operator user, `A` in the cases. */
  actor: string
  /** Statements the repository has sent so far (memory: always 0). */
  queries(): number
  report(opts?: SeedReport): Promise<{ id: string; title: string | null; referenceCode: string }>
  filing(row: FilingSeedRow): Promise<string>
  evidence(
    filingId: string,
    e: { r2Key: string; kind: FilingEvidenceKind; label: string | null; createdAt: Date },
  ): Promise<void>
  mailThread(): Promise<string>
  mailMessage(threadId: string): Promise<string>
  inboundEmail(): Promise<string>
  setReport(id: string, patch: Partial<WorldReport>): Promise<void>
  getReport(id: string): Promise<WorldReport>
  timeline(reportId: string): Promise<WorldTimelineRow[]>
  audits(): Promise<WorldAuditRow[]>
  filingIds(reportId: string): Promise<string[]>
  messageCount(): Promise<number>
}

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const AUDIT_ACTION = "report.status_changed" as const

function ago(ms: number, from = Date.now()): Date {
  return new Date(from - ms)
}

export function seedRow(s: SeedFiling): FilingSeedRow {
  const now = new Date()
  const successful = s.status === "submitted" || s.status === "linked_existing"
  return {
    reportId: s.reportId,
    geoid: s.geoid ?? null,
    category: s.category ?? "pothole",
    routeCategory: s.routeCategory ?? null,
    channel: s.channel === undefined ? "email" : s.channel,
    portalHost: s.portalHost ?? null,
    formUrl: s.formUrl ?? null,
    status: s.status,
    method: s.method ?? null,
    reason: s.reason ?? null,
    reasonDetail: s.reasonDetail ?? null,
    caseId: s.caseId ?? null,
    caseUrl: s.caseUrl ?? null,
    cityClosedAt: s.cityClosedAt ?? null,
    attempts: s.attempts ?? 0,
    runId: s.runId ?? null,
    nextAttemptAt: s.nextAttemptAt ?? null,
    aiWaitSince: s.aiWaitSince ?? null,
    scriptVersion: s.scriptVersion ?? null,
    dryRun: s.dryRun ?? false,
    ticketText: s.ticketText ?? "t",
    note: s.note ?? null,
    mailThreadId: s.mailThreadId ?? null,
    createdBy: s.createdBy ?? null,
    createdAt: s.createdAt ?? now,
    updatedAt: s.updatedAt ?? s.createdAt ?? now,
    submittedAt: s.submittedAt === undefined ? (successful ? now : null) : s.submittedAt,
  }
}

function createdFiling(res: CreateFilingResult): FilingRecord {
  if (res.kind !== "created") throw new Error(`expected created, got ${res.kind}`)
  return res.filing
}

function errorCode(err: unknown): unknown {
  return typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p
  } catch (err) {
    return err
  }
  throw new Error("expected the call to reject")
}

export function defineFilingRepositoryCases(setup: () => Promise<FilingWorld>): void {
  let w: FilingWorld
  const seed = (s: SeedFiling): Promise<string> => w.filing(seedRow(s))
  const audit = (target: string): WriteAuditInput => ({
    action: AUDIT_ACTION,
    actorId: w.actor,
    target,
  })
  const get = async (id: string): Promise<FilingRecord> => {
    const f = await w.repo.getById(id)
    if (f === null) throw new Error(`filing ${id} is gone`)
    return f
  }

  beforeEach(async () => {
    w = await setup()
  })

  describe("create", () => {
    it("T12: creates a queued filing with its jurisdiction name", async () => {
      const r = await w.report()
      const res = await w.repo.create({
        reportId: r.id,
        geoid: w.G,
        category: "pothole",
        channel: "email",
        status: "queued",
        ticketText: "t",
      })
      expect(res.kind).toBe("created")
      expect(createdFiling(res)).toMatchObject({
        reportId: r.id,
        status: "queued",
        attempts: 0,
        runId: null,
        dryRun: false,
        jurisdictionName: "City of Los Angeles",
      })
    })

    it("T13: a report with a queued, running or needs_human filing gets active_exists", async () => {
      for (const status of ["queued", "running", "needs_human"] as const) {
        const r = await w.report()
        await seed({ reportId: r.id, geoid: w.G, status })
        const res = await w.repo.create({
          reportId: r.id,
          geoid: w.G,
          category: "pothole",
          status: "queued",
          ticketText: "t",
        })
        expect(res).toEqual({ kind: "active_exists" })
        expect(await w.filingIds(r.id)).toHaveLength(1)
      }
    })

    it("T14: once the active filing is cancelled, a new one is created", async () => {
      const r = await w.report()
      const input = {
        reportId: r.id,
        geoid: w.G,
        category: "pothole",
        status: "queued",
        ticketText: "t",
      } as const
      const first = createdFiling(await w.repo.create(input))
      expect(
        await w.repo.transition(first.id, { from: ["queued"], set: { status: "cancelled" } }),
      ).not.toBeNull()
      expect((await w.repo.create(input)).kind).toBe("created")
      expect(await w.filingIds(r.id)).toHaveLength(2)
    })

    it("T15: the audit is written with the filing, and not when the filing is refused", async () => {
      const r = await w.report()
      const input = {
        reportId: r.id,
        geoid: w.G,
        category: "pothole",
        status: "queued",
        ticketText: "t",
      } as const
      expect((await w.repo.create(input, audit(`report:${r.id}`))).kind).toBe("created")
      expect(await w.audits()).toEqual([
        { action: AUDIT_ACTION, actorId: w.actor, target: `report:${r.id}` },
      ])
      expect(await w.repo.create(input, audit(`report:${r.id}`))).toEqual({
        kind: "active_exists",
      })
      expect(await w.audits()).toHaveLength(1)
    })

    it("T16: a jurisdiction-less filing has no geoid, channel or jurisdiction name", async () => {
      const r = await w.report({ geoid: null })
      const filing = createdFiling(
        await w.repo.create({
          reportId: r.id,
          geoid: null,
          channel: null,
          category: "pothole",
          reason: "no_route",
          status: "needs_human",
          ticketText: "t",
        }),
      )
      expect(filing).toMatchObject({
        geoid: null,
        channel: null,
        jurisdictionName: null,
        reason: "no_route",
      })
    })
  })

  describe("reads", () => {
    it("T17: getById returns null for an unknown id and the filing with its jurisdiction", async () => {
      expect(await w.repo.getById(randomUUID())).toBeNull()
      const r = await w.report()
      const created = createdFiling(
        await w.repo.create({
          reportId: r.id,
          geoid: w.G,
          category: "pothole",
          status: "queued",
          ticketText: "t",
        }),
      )
      expect(await w.repo.getById(created.id)).toEqual(created)
      expect((await get(created.id)).jurisdictionName).toBe("City of Los Angeles")
    })

    it("T18: getActiveForReport skips cancelled and successful filings", async () => {
      const r = await w.report()
      const r2 = await w.report()
      await seed({ reportId: r.id, geoid: w.G, status: "cancelled" })
      const queued = await seed({ reportId: r.id, geoid: w.G, status: "queued" })
      await seed({ reportId: r2.id, geoid: w.G, status: "submitted" })
      expect((await w.repo.getActiveForReport(r.id))?.id).toBe(queued)
      expect(await w.repo.getActiveForReport(r2.id)).toBeNull()
    })

    it("T19: getLatestSuccessfulForReport orders by submitted_at", async () => {
      const r = await w.report()
      await seed({ reportId: r.id, geoid: w.G, status: "submitted", submittedAt: ago(2 * DAY) })
      const linked = await seed({
        reportId: r.id,
        geoid: w.G,
        status: "linked_existing",
        submittedAt: ago(DAY),
        createdAt: ago(3 * DAY),
      })
      await seed({ reportId: r.id, geoid: w.G, status: "needs_human" })
      const latest = await w.repo.getLatestSuccessfulForReport(r.id)
      expect(latest?.id).toBe(linked)
      expect(latest?.jurisdictionName).toBe("City of Los Angeles")

      const r2 = await w.report()
      await seed({ reportId: r2.id, geoid: w.G, status: "needs_human" })
      expect(await w.repo.getLatestSuccessfulForReport(r2.id)).toBeNull()
    })

    it("T20: getLatestSuccessfulForReports returns one row per filed report", async () => {
      const [r, r2, r3] = [await w.report(), await w.report(), await w.report()]
      await seed({ reportId: r.id, geoid: w.G, status: "submitted", submittedAt: ago(2 * DAY) })
      const newest = await seed({
        reportId: r.id,
        geoid: w.G,
        status: "linked_existing",
        submittedAt: ago(DAY),
      })
      const only = await seed({ reportId: r2.id, geoid: w.G2, status: "submitted" })
      await seed({ reportId: r3.id, geoid: w.G, status: "needs_human" })

      const rows = await w.repo.getLatestSuccessfulForReports([r.id, r2.id, r3.id])
      expect(rows).toHaveLength(2)
      expect(rows.find((f) => f.reportId === r.id)).toMatchObject({
        id: newest,
        jurisdictionName: "City of Los Angeles",
      })
      expect(rows.find((f) => f.reportId === r2.id)).toMatchObject({
        id: only,
        jurisdictionName: "G2 City",
      })

      const before = w.queries()
      expect(await w.repo.getLatestSuccessfulForReports([])).toEqual([])
      expect(w.queries()).toBe(before)
    })

    it("T21: more than 100 report ids is a caller bug, refused before any query", async () => {
      const ids = Array.from({ length: 101 }, () => randomUUID())
      const before = w.queries()
      await expect(w.repo.getLatestSuccessfulForReports(ids)).rejects.toThrow(Error)
      expect(w.queries()).toBe(before)
    })
  })

  describe("transition", () => {
    it("T22: refuses submitted -> queued and leaves the row alone", async () => {
      const r = await w.report()
      const id = await seed({ reportId: r.id, geoid: w.G, status: "submitted" })
      const before = await get(id)
      expect(
        await w.repo.transition(id, { from: ["needs_human"], set: { status: "queued" } }),
      ).toBeNull()
      expect(await get(id)).toEqual(before)
    })

    it("T23: refuses a stale attempts and applies the current one", async () => {
      const r = await w.report()
      const id = await seed({
        reportId: r.id,
        geoid: w.G,
        status: "running",
        attempts: 2,
        updatedAt: ago(MINUTE),
      })
      const before = await get(id)
      const set = { status: "needs_human", reason: "portal_error" } as const
      expect(await w.repo.transition(id, { from: ["running"], attempts: 1, set })).toBeNull()
      expect(await get(id)).toEqual(before)

      const after = await w.repo.transition(id, { from: ["running"], attempts: 2, set })
      expect(after).toMatchObject({ id, status: "needs_human", reason: "portal_error" })
      expect(after!.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime())
    })

    it("T24: audit and evidence are written only when the guard passes", async () => {
      const r = await w.report()
      const id = await seed({ reportId: r.id, geoid: w.G, status: "queued" })
      const extras = {
        audit: audit(`report:${r.id}`),
        evidence: [{ r2Key: "k1", kind: "screenshot", label: "Final page" }] as const,
        set: { status: "cancelled" } as const,
      }
      expect(await w.repo.transition(id, { from: ["running"], ...extras })).toBeNull()
      expect(await w.audits()).toEqual([])
      expect(await w.repo.listEvidence(id)).toEqual([])

      expect(await w.repo.transition(id, { from: ["queued"], ...extras })).not.toBeNull()
      expect(await w.audits()).toHaveLength(1)
      const evidence = await w.repo.listEvidence(id)
      expect(evidence).toHaveLength(1)
      expect(evidence[0]).toMatchObject({
        filingId: id,
        r2Key: "k1",
        kind: "screenshot",
        label: "Final page",
      })
    })
  })

  describe("recordSuccess", () => {
    const NOTE = "Filed with City of Los Angeles · Request 1-2345"

    async function filedFrom(status: string) {
      const r = await w.report({ status })
      const id = await seed({ reportId: r.id, geoid: w.G, status: "queued" })
      const res = await w.repo.recordSuccess({
        filingId: id,
        from: { status: ["queued", "needs_human"] },
        outcome: "submitted",
        method: "operator",
        caseId: "1-2345",
        caseUrl: "https://example.gov/r/1",
        note: NOTE,
        actorId: w.actor,
      })
      return { r, id, res }
    }

    it("T26: a published report moves to acknowledged with one route timeline row", async () => {
      const { r, id, res } = await filedFrom("published")
      expect(res?.reportChanged).toBe(true)
      expect(res?.filing).toMatchObject({
        id,
        status: "submitted",
        method: "operator",
        caseId: "1-2345",
        caseUrl: "https://example.gov/r/1",
      })
      expect(res?.filing.submittedAt).toBeInstanceOf(Date)
      expect((await w.getReport(r.id)).status).toBe("acknowledged")
      expect(await w.timeline(r.id)).toEqual([
        { kind: "route", status: "acknowledged", note: NOTE, actorId: w.actor },
      ])
    })

    it("T27: submitted and held reports move to acknowledged too", async () => {
      for (const status of ["submitted", "held"]) {
        const { r, res } = await filedFrom(status)
        expect(res?.reportChanged).toBe(true)
        expect((await w.getReport(r.id)).status).toBe("acknowledged")
        const timeline = await w.timeline(r.id)
        expect(timeline).toHaveLength(1)
        expect(timeline[0]).toMatchObject({ kind: "route", status: "acknowledged" })
      }
    })

    it("T28: an in_progress report keeps its status and still gets the route row", async () => {
      const { r, res } = await filedFrom("in_progress")
      expect(res?.filing.status).toBe("submitted")
      expect(res?.reportChanged).toBe(true)
      expect((await w.getReport(r.id)).status).toBe("in_progress")
      expect(await w.timeline(r.id)).toEqual([
        { kind: "route", status: "in_progress", note: NOTE, actorId: w.actor },
      ])
    })

    it("T29: a report no longer fileable is left alone while the filing is updated", async () => {
      const patches = [
        { deletedAt: new Date() },
        { status: "rejected" },
        { verificationVerdict: "rejected" },
      ] as const
      for (const patch of patches) {
        const r = await w.report({ status: "published" })
        const id = await seed({ reportId: r.id, geoid: w.G, status: "queued" })
        await w.setReport(r.id, patch)
        const before = await w.getReport(r.id)
        const res = await w.repo.recordSuccess({
          filingId: id,
          from: { status: ["queued", "needs_human"] },
          outcome: "submitted",
          method: "operator",
          note: NOTE,
          actorId: w.actor,
        })
        expect(res?.reportChanged).toBe(false)
        expect(res?.filing.status).toBe("submitted")
        expect(res?.filing.submittedAt).toBeInstanceOf(Date)
        expect(await w.getReport(r.id)).toEqual(before)
        expect(await w.timeline(r.id)).toEqual([])
      }
    })

    it("T30: a failed guard changes nothing anywhere", async () => {
      const cases = [
        { attempts: 0, from: { status: ["queued"] as FilingStatus[] } },
        { attempts: 2, from: { status: ["running"] as FilingStatus[], attempts: 1 } },
      ]
      for (const c of cases) {
        const r = await w.report({ status: "published" })
        const id = await seed({
          reportId: r.id,
          geoid: w.G,
          status: "running",
          attempts: c.attempts,
        })
        const before = await get(id)
        const res = await w.repo.recordSuccess({
          filingId: id,
          from: c.from,
          outcome: "submitted",
          method: "script",
          note: NOTE,
          audit: audit(`report:${r.id}`),
          evidence: [{ r2Key: "k", kind: "screenshot" }],
        })
        expect(res).toBeNull()
        expect(await get(id)).toEqual(before)
        expect((await w.getReport(r.id)).status).toBe("published")
        expect(await w.timeline(r.id)).toEqual([])
        expect(await w.audits()).toEqual([])
        expect(await w.repo.listEvidence(id)).toEqual([])
      }
    })

    it("T31: the guard can require the needs_human reason", async () => {
      const r = await w.report()
      const id = await seed({
        reportId: r.id,
        geoid: w.G,
        status: "needs_human",
        reason: "uncertain_submission",
      })
      const base = { filingId: id, outcome: "submitted", method: "email", note: NOTE } as const
      expect(
        await w.repo.recordSuccess({
          ...base,
          from: { status: ["needs_human"], reason: "city_needs_info" },
        }),
      ).toBeNull()
      expect(
        await w.repo.recordSuccess({
          ...base,
          from: { status: ["needs_human"], reason: "uncertain_submission" },
        }),
      ).not.toBeNull()
    })

    it("T32: newFiling inserts a submitted filing beside the report's needs_human one", async () => {
      const r = await w.report({ status: "published" })
      const stuck = await seed({ reportId: r.id, geoid: w.G, status: "needs_human" })
      const stuckBefore = await get(stuck)
      const thread = await w.mailThread()
      const res = await w.repo.recordSuccess({
        newFiling: {
          reportId: r.id,
          geoid: w.G,
          channel: "email",
          category: "pothole",
          ticketText: "t",
        },
        outcome: "submitted",
        method: "email",
        mailThreadId: thread,
        note: "Filed with City of Los Angeles",
      })
      expect(res?.filing).toMatchObject({
        reportId: r.id,
        status: "submitted",
        method: "email",
        mailThreadId: thread,
        jurisdictionName: "City of Los Angeles",
      })
      expect(res?.filing.id).not.toBe(stuck)
      expect(res?.filing.submittedAt).toBeInstanceOf(Date)
      expect(await get(stuck)).toEqual(stuckBefore)
      expect((await w.getReport(r.id)).status).toBe("acknowledged")
      expect(await w.timeline(r.id)).toHaveLength(1)
    })

    it("T33: linked_existing records the case id with the same report effects", async () => {
      const r = await w.report({ status: "published" })
      const id = await seed({ reportId: r.id, geoid: w.G, status: "queued" })
      const note = "Linked to City of Los Angeles request 1-999"
      const res = await w.repo.recordSuccess({
        filingId: id,
        from: { status: ["queued"] },
        outcome: "linked_existing",
        method: "operator",
        caseId: "1-999",
        note,
        actorId: w.actor,
      })
      expect(res?.filing).toMatchObject({ status: "linked_existing", caseId: "1-999" })
      expect(res?.reportChanged).toBe(true)
      expect((await w.getReport(r.id)).status).toBe("acknowledged")
      expect(await w.timeline(r.id)).toEqual([
        { kind: "route", status: "acknowledged", note, actorId: w.actor },
      ])
    })

    it("T34: audit and evidence are written with a success and not with a failed guard", async () => {
      const r = await w.report()
      const id = await seed({ reportId: r.id, geoid: w.G, status: "running", attempts: 1 })
      const extras = {
        outcome: "submitted",
        method: "script",
        note: NOTE,
        audit: audit(`report:${r.id}`),
        evidence: [{ r2Key: "final.png", kind: "screenshot", label: "Confirmation" }],
      } as const
      expect(
        await w.repo.recordSuccess({
          filingId: id,
          from: { status: ["running"], attempts: 1 },
          ...extras,
        }),
      ).not.toBeNull()
      expect(await w.audits()).toHaveLength(1)
      expect(await w.repo.listEvidence(id)).toHaveLength(1)

      const r2 = await w.report()
      const other = await seed({ reportId: r2.id, geoid: w.G, status: "running", attempts: 1 })
      expect(
        await w.repo.recordSuccess({ filingId: other, from: { status: ["queued"] }, ...extras }),
      ).toBeNull()
      expect(await w.audits()).toHaveLength(1)
      expect(await w.repo.listEvidence(other)).toEqual([])
    })
  })

  describe("claim", () => {
    it("T35: claims a queued filing once", async () => {
      const r = await w.report()
      const id = await seed({ reportId: r.id, geoid: w.G, status: "queued" })
      const claimed = await w.repo.claim(id, 1)
      expect(claimed?.runId).toMatch(UUID_RE)
      expect(await get(id)).toMatchObject({
        status: "running",
        attempts: 1,
        runId: claimed?.runId,
      })
      expect(await w.repo.claim(id, 1)).toBeNull()
    })

    it("T36: claims only the next attempt of a queued filing", async () => {
      const r = await w.report()
      const previousRun = randomUUID()
      const id = await seed({
        reportId: r.id,
        geoid: w.G,
        status: "queued",
        attempts: 1,
        runId: previousRun,
      })
      expect(await w.repo.claim(id, 3)).toBeNull()
      const claimed = await w.repo.claim(id, 2)
      expect(claimed?.runId).toMatch(UUID_RE)
      expect(claimed?.runId).not.toBe(previousRun)

      const r2 = await w.report()
      const stuck = await seed({ reportId: r2.id, geoid: w.G, status: "needs_human" })
      expect(await w.repo.claim(stuck, 1)).toBeNull()
    })
  })

  describe("list and counts", () => {
    it("T37: pages a group newest first with report and jurisdiction fields", async () => {
      const seeded: { id: string; title: string | null; referenceCode: string }[] = []
      for (const minutes of [3, 2, 1]) {
        const r = await w.report({ title: `Report ${minutes}` })
        const id = await seed({
          reportId: r.id,
          geoid: w.G,
          status: "needs_human",
          updatedAt: ago(minutes * MINUTE),
        })
        seeded.push({ id, title: r.title, referenceCode: r.referenceCode })
      }
      const [oldest, middle, newest] = seeded

      const page1 = await w.repo.list({ group: "needs_human", limit: 2 })
      expect(page1.records.map((f) => f.id)).toEqual([newest!.id, middle!.id])
      expect(page1.nextCursor).not.toBeNull()
      expect(page1.records[0]).toMatchObject({
        reportTitle: newest!.title,
        referenceCode: newest!.referenceCode,
        jurisdictionName: "City of Los Angeles",
      })

      const page2 = await w.repo.list({ group: "needs_human", limit: 2, cursor: page1.nextCursor })
      expect(page2.records.map((f) => f.id)).toEqual([oldest!.id])
      expect(page2.nextCursor).toBeNull()
    })

    it("T38: each group lists exactly its statuses", async () => {
      const byStatus = new Map<FilingStatus, string>()
      const statuses: FilingStatus[] = [
        "queued",
        "running",
        "submitted",
        "linked_existing",
        "needs_human",
        "cancelled",
      ]
      for (const status of statuses) {
        const r = await w.report()
        byStatus.set(status, await seed({ reportId: r.id, geoid: w.G, status }))
      }
      const ids = (s: FilingStatus[]) => s.map((x) => byStatus.get(x)).sort()
      const listed = async (group: "needs_human" | "in_progress" | "filed" | "cancelled") =>
        (await w.repo.list({ group })).records.map((f) => f.id).sort()

      expect(await listed("needs_human")).toEqual(ids(["needs_human"]))
      expect(await listed("in_progress")).toEqual(ids(["queued", "running"]))
      expect(await listed("filed")).toEqual(ids(["submitted", "linked_existing"]))
      expect(await listed("cancelled")).toEqual(ids(["cancelled"]))
    })

    it("T39: the limit is clamped to 50 and a bad cursor reads as the first page", async () => {
      const r = await w.report()
      for (let i = 0; i < 55; i++) {
        await seed({ reportId: r.id, geoid: w.G, status: "cancelled", updatedAt: ago(i * MINUTE) })
      }
      const first = await w.repo.list({ group: "cancelled", limit: 80 })
      expect(first.records).toHaveLength(50)
      const garbage = await w.repo.list({ group: "cancelled", limit: 80, cursor: "garbage" })
      expect(garbage.records.map((f) => f.id)).toEqual(first.records.map((f) => f.id))
    })

    it("T41: countGroups counts needs_human and in_progress", async () => {
      const statuses: FilingStatus[] = [
        "needs_human",
        "needs_human",
        "queued",
        "running",
        "submitted",
        "submitted",
        "submitted",
        "cancelled",
      ]
      for (const status of statuses) {
        const r = await w.report()
        await seed({ reportId: r.id, geoid: w.G, status })
      }
      expect(await w.repo.countGroups()).toEqual({ needs_human: 2, in_progress: 2 })
    })
  })

  describe("listDueQueued", () => {
    async function dueWorld(N: number) {
      const seeds: {
        key: string
        status: FilingStatus
        channel: FilingChannel | null
        next: Date | null
        updated: Date
      }[] = [
        { key: "a", status: "queued", channel: "email", next: null, updated: ago(20 * MINUTE, N) },
        {
          key: "b",
          status: "queued",
          channel: "email",
          next: ago(MINUTE, N),
          updated: ago(15 * MINUTE, N),
        },
        {
          key: "c",
          status: "queued",
          channel: "email",
          next: ago(-MINUTE, N),
          updated: ago(20 * MINUTE, N),
        },
        { key: "d", status: "queued", channel: "email", next: null, updated: ago(5 * MINUTE, N) },
        {
          key: "portal",
          status: "queued",
          channel: "portal",
          next: null,
          updated: ago(20 * MINUTE, N),
        },
        { key: "none", status: "queued", channel: null, next: null, updated: ago(20 * MINUTE, N) },
        {
          key: "running",
          status: "running",
          channel: "email",
          next: null,
          updated: ago(20 * MINUTE, N),
        },
      ]
      const ids = new Map<string, string>()
      for (const [i, s] of seeds.entries()) {
        const r = await w.report()
        const id = await seed({
          reportId: r.id,
          geoid: w.G,
          status: s.status,
          channel: s.channel,
          nextAttemptAt: s.next,
          createdAt: ago((60 - i) * MINUTE, N),
          updatedAt: s.updated,
        })
        ids.set(s.key, id)
      }
      return (...keys: string[]) => keys.map((k) => ids.get(k))
    }

    it("T42: returns due, old-enough queued filings of the channels, oldest first", async () => {
      const N = Date.now()
      const pick = await dueWorld(N)
      const due = await w.repo.listDueQueued({
        now: new Date(N),
        updatedBefore: ago(10 * MINUTE, N),
        channels: ["email"],
        limit: 100,
      })
      expect(due.map((f) => f.id)).toEqual(pick("a", "b"))
    })

    it("T43: a null updatedBefore skips the age test, and the limit is clamped to 100", async () => {
      const N = Date.now()
      const pick = await dueWorld(N)
      const args = { now: new Date(N), updatedBefore: null, channels: ["email", "portal"] } as const
      expect((await w.repo.listDueQueued({ ...args, limit: 100 })).map((f) => f.id)).toEqual(
        pick("a", "b", "d", "portal"),
      )
      expect((await w.repo.listDueQueued({ ...args, limit: 1 })).map((f) => f.id)).toEqual(
        pick("a"),
      )
      for (let i = 0; i < 101; i++) {
        const r = await w.report()
        await seed({ reportId: r.id, geoid: w.G, status: "queued", createdAt: ago(MINUTE, N) })
      }
      expect(await w.repo.listDueQueued({ ...args, limit: 500 })).toHaveLength(100)
    })
  })

  describe("runner reads", () => {
    it("T44: listRunningFilings returns every running filing's id, attempts and run id", async () => {
      const expected = []
      for (const attempts of [1, 2]) {
        const r = await w.report()
        const runId = randomUUID()
        const id = await seed({ reportId: r.id, geoid: w.G, status: "running", attempts, runId })
        expected.push({ id, attempts, runId })
      }
      const r = await w.report()
      await seed({ reportId: r.id, geoid: w.G, status: "queued" })
      const running = await w.repo.listRunningFilings()
      const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id)
      expect([...running].sort(byId)).toEqual(expected.sort(byId))
    })

    it("T45: getLatestByMailThread returns the newest filing on that thread", async () => {
      const r = await w.report()
      const t = await w.mailThread()
      const other = await w.mailThread()
      await seed({
        reportId: r.id,
        geoid: w.G,
        status: "submitted",
        mailThreadId: t,
        createdAt: ago(2 * DAY),
      })
      const newer = await seed({
        reportId: r.id,
        geoid: w.G,
        status: "submitted",
        mailThreadId: t,
        createdAt: ago(DAY),
      })
      await seed({ reportId: r.id, geoid: w.G, status: "submitted", mailThreadId: other })
      expect(await w.repo.getLatestByMailThread(t)).toMatchObject({
        id: newer,
        jurisdictionName: "City of Los Angeles",
      })
      expect(await w.repo.getLatestByMailThread(randomUUID())).toBeNull()
    })

    it("T46: listEvidence returns one filing's evidence oldest first, at most 50", async () => {
      const r = await w.report()
      const id = await seed({ reportId: r.id, geoid: w.G, status: "submitted" })
      const other = await seed({ reportId: r.id, geoid: w.G, status: "submitted" })
      for (const [key, minutes] of [
        ["k2", 2],
        ["k3", 1],
        ["k1", 3],
      ] as const) {
        await w.evidence(id, {
          r2Key: key,
          kind: "screenshot",
          label: null,
          createdAt: ago(minutes * MINUTE),
        })
      }
      await w.evidence(other, { r2Key: "x", kind: "script", label: null, createdAt: new Date() })
      expect((await w.repo.listEvidence(id)).map((e) => e.r2Key)).toEqual(["k1", "k2", "k3"])

      const many = await seed({ reportId: r.id, geoid: w.G, status: "submitted" })
      for (let i = 0; i < 52; i++) {
        await w.evidence(many, {
          r2Key: `m${i}`,
          kind: "screenshot",
          label: null,
          createdAt: ago(i * MINUTE),
        })
      }
      expect(await w.repo.listEvidence(many)).toHaveLength(50)
    })
  })

  describe("routes", () => {
    const email = (category: string | null) => ({ category, channel: "email" }) as const

    it("T47: listRoutes returns the default first, then categories ascending", async () => {
      await w.repo.replaceRoutes(w.G, [email("pothole"), email(null), email("graffiti")])
      await w.repo.replaceRoutes(w.G2, [email(null)])
      expect((await w.repo.listRoutes(w.G)).map((x) => x.category)).toEqual([
        null,
        "graffiti",
        "pothole",
      ])
      const g2 = await w.repo.listRoutes(w.G2)
      expect(g2).toHaveLength(1)
      expect(g2[0]).toMatchObject({
        geoid: w.G2,
        category: null,
        channel: "email",
        includeLink: true,
        enabled: true,
        statusSenderDomains: [],
      })
    })

    it("T48: findRoutes returns the category's route and the default", async () => {
      await w.repo.replaceRoutes(w.G, [email(null), email("pothole")])
      expect((await w.repo.findRoutes(w.G, "pothole")).map((x) => x.category).sort()).toEqual(
        ["pothole", null].sort(),
      )
      expect((await w.repo.findRoutes(w.G, "graffiti")).map((x) => x.category)).toEqual([null])
      expect(await w.repo.findRoutes(w.G2, "pothole")).toEqual([])
    })

    it("T49: replaceRoutes replaces only that jurisdiction's routes, with the actor", async () => {
      await w.repo.replaceRoutes(w.G2, [email(null)])
      const g2Before = await w.repo.listRoutes(w.G2)
      const a = audit(`jurisdiction:${w.G}`)
      await w.repo.replaceRoutes(
        w.G,
        [
          email(null),
          { category: "pothole", channel: "portal", formUrl: "https://portal.example.gov/new" },
        ],
        a,
      )
      await w.repo.replaceRoutes(w.G, [{ category: null, channel: "manual" }], a)
      const routes = await w.repo.listRoutes(w.G)
      expect(routes).toHaveLength(1)
      expect(routes[0]).toMatchObject({ category: null, channel: "manual", updatedBy: w.actor })
      expect(routes[0]!.updatedAt).toBeInstanceOf(Date)
      expect(await w.repo.listRoutes(w.G2)).toEqual(g2Before)
      expect(await w.audits()).toHaveLength(2)
    })

    it("T50: a refused route set leaves the old routes and writes no audit", async () => {
      await w.repo.replaceRoutes(w.G, [email(null)])
      const before = await w.repo.listRoutes(w.G)
      const a = audit(`jurisdiction:${w.G}`)

      const noForm = await rejection(
        w.repo.replaceRoutes(w.G, [{ category: "pothole", channel: "portal", formUrl: null }], a),
      )
      expect(noForm).toBeInstanceOf(Error)
      if (w.kind === "pg") expect(errorCode(noForm)).toBe("23514")

      const twice = await rejection(
        w.repo.replaceRoutes(w.G, [email("pothole"), email("pothole")], a),
      )
      expect(twice).toBeInstanceOf(Error)
      if (w.kind === "pg") expect(errorCode(twice)).toBe("23505")

      expect(await w.repo.listRoutes(w.G)).toEqual(before)
      expect(await w.audits()).toEqual([])
    })

    it("T51: routeHealth summarizes each route category of one jurisdiction", async () => {
      const t1 = ago(5 * DAY)
      const t2 = ago(3 * DAY)
      const t3 = ago(DAY)
      const t4 = ago(2 * DAY)
      const r = await w.report()
      const base = { reportId: r.id, geoid: w.G, routeCategory: null }
      await seed({
        ...base,
        status: "submitted",
        submittedAt: t1,
        updatedAt: t1,
        scriptVersion: "v1",
      })
      await seed({
        ...base,
        status: "linked_existing",
        submittedAt: t2,
        updatedAt: t2,
        scriptVersion: "v2",
      })
      await seed({ ...base, status: "needs_human", updatedAt: t3 })
      const r2 = await w.report()
      await seed({
        reportId: r2.id,
        geoid: w.G,
        routeCategory: "pothole",
        status: "needs_human",
        updatedAt: t4,
      })
      const r3 = await w.report({ geoid: w.G2 })
      await seed({ reportId: r3.id, geoid: w.G2, status: "submitted", scriptVersion: "v9" })

      const health = await w.repo.routeHealth(w.G)
      expect(health).toHaveLength(2)
      expect(health.find((x) => x.routeCategory === null)).toEqual({
        routeCategory: null,
        lastFiledAt: t2,
        lastFailedAt: t3,
        scriptVersion: "v2",
      })
      expect(health.find((x) => x.routeCategory === "pothole")).toEqual({
        routeCategory: "pothole",
        lastFiledAt: null,
        lastFailedAt: t4,
        scriptVersion: null,
      })
    })
  })

  describe("settings", () => {
    it("T52: setPaused records the actor and the time", async () => {
      const fresh = await w.repo.getSettings()
      expect(fresh).toMatchObject({ paused: false, updatedBy: null })
      await w.repo.setPaused(true, audit("filing:settings"))
      const after = await w.repo.getSettings()
      expect(after).toMatchObject({ paused: true, updatedBy: w.actor })
      expect(after.updatedAt.getTime()).toBeGreaterThan(fresh.updatedAt.getTime())
      expect(await w.audits()).toHaveLength(1)
    })
  })

  describe("messages", () => {
    async function linked() {
      const r = await w.report()
      const filingId = await seed({ reportId: r.id, geoid: w.G, status: "submitted" })
      const e = await w.inboundEmail()
      const m = await w.mailMessage(await w.mailThread())
      return { filingId, e, m }
    }

    it("T53: insertMessageIfAbsent links a message once", async () => {
      const { filingId, e, m } = await linked()
      const first = await w.repo.insertMessageIfAbsent({
        filingId,
        inboundEmailId: e,
        trusted: true,
      })
      expect(first).toMatchObject({
        filingId,
        inboundEmailId: e,
        mailMessageId: null,
        trusted: true,
        flagged: false,
        appliedAt: null,
      })
      expect(
        await w.repo.insertMessageIfAbsent({ filingId, inboundEmailId: e, trusted: true }),
      ).toBeNull()
      expect(await w.messageCount()).toBe(1)

      const reply = await w.repo.insertMessageIfAbsent({
        filingId,
        mailMessageId: m,
        trusted: false,
      })
      expect(reply).toMatchObject({
        filingId,
        inboundEmailId: null,
        mailMessageId: m,
        trusted: false,
      })
      expect(
        await w.repo.insertMessageIfAbsent({ filingId, mailMessageId: m, trusted: false }),
      ).toBeNull()
      expect(await w.messageCount()).toBe(2)
    })

    it("T54: messages are found by their inbox or mail message id", async () => {
      const { filingId, e, m } = await linked()
      const inbox = await w.repo.insertMessageIfAbsent({
        filingId,
        inboundEmailId: e,
        trusted: true,
      })
      const reply = await w.repo.insertMessageIfAbsent({
        filingId,
        mailMessageId: m,
        trusted: true,
      })
      expect(await w.repo.getMessageByInboundEmailId(e)).toEqual(inbox)
      expect(await w.repo.getMessageByMailMessageId(m)).toEqual(reply)
      expect(await w.repo.getMessageByInboundEmailId(randomUUID())).toBeNull()
      expect(await w.repo.getMessageByMailMessageId(randomUUID())).toBeNull()
    })

    it("T55: flagMessage sets only flagged", async () => {
      const { filingId, e } = await linked()
      const row = await w.repo.insertMessageIfAbsent({ filingId, inboundEmailId: e, trusted: true })
      await w.repo.flagMessage(row!.id)
      expect(await w.repo.getMessageByInboundEmailId(e)).toEqual({ ...row, flagged: true })
    })
  })

  describe("findByCaseIds", () => {
    it("T56: matches successful filings of the last 180 days, case-sensitively", async () => {
      const r = await w.report()
      const base = { reportId: r.id, geoid: w.G }
      const recent = await seed({
        ...base,
        status: "submitted",
        caseId: "1-2345",
        submittedAt: ago(10 * DAY),
      })
      const linked = await seed({
        ...base,
        status: "linked_existing",
        caseId: "ABC-77",
        submittedAt: ago(179 * DAY),
      })
      await seed({ ...base, status: "submitted", caseId: "OLD-11", submittedAt: ago(181 * DAY) })
      await seed({ ...base, status: "needs_human", caseId: "NH-123" })
      const found = await w.repo.findByCaseIds(["1-2345", "ABC-77", "OLD-11", "NH-123", "abc-77"])
      expect(found.map((f) => f.id).sort()).toEqual([recent, linked].sort())
    })

    it("T57: bounds: no tokens, too many tokens, and at most 50 rows", async () => {
      const before = w.queries()
      expect(await w.repo.findByCaseIds([])).toEqual([])
      const tooMany = Array.from({ length: 501 }, (_, i) => `TOKEN-${i}`)
      await expect(w.repo.findByCaseIds(tooMany)).rejects.toThrow(Error)
      expect(w.queries()).toBe(before)

      const r = await w.report()
      for (let i = 0; i < 60; i++) {
        await seed({ reportId: r.id, geoid: w.G, status: "submitted", caseId: "DUP-1" })
      }
      expect(await w.repo.findByCaseIds(["DUP-1"])).toHaveLength(50)
    })
  })
}
