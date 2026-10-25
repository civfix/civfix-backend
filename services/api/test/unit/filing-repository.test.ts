import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import type { FilingRepository } from "../../src/services/filings/filing-repository.js"
import type { makeDrizzleFilingRepository } from "../../src/services/filings/filing-repository.drizzle.js"
import { InMemoryFilingRepository } from "../helpers/filings/filing-repository.memory.js"
import {
  defineFilingRepositoryCases,
  type FilingWorld,
} from "../helpers/filings/filing-repository-cases.js"

const G = "0644000"
const G2 = "0600001"

function memoryWorld(): FilingWorld {
  const repo = new InMemoryFilingRepository()
  repo.jurisdictions.set(G, "City of Los Angeles")
  repo.jurisdictions.set(G2, "G2 City")
  let refs = 0
  return {
    kind: "memory",
    repo,
    G,
    G2,
    actor: randomUUID(),
    queries: () => 0,
    report(opts = {}) {
      const id = randomUUID()
      refs += 1
      const report = {
        id,
        geoid: opts.geoid === undefined ? G : opts.geoid,
        status: opts.status ?? "published",
        title: opts.title ?? null,
        referenceCode: `CF-${String(refs).padStart(6, "0")}`,
        deletedAt: opts.deletedAt ?? null,
        verificationVerdict: opts.verificationVerdict ?? null,
      }
      repo.reports.set(id, report)
      return Promise.resolve({ id, title: report.title, referenceCode: report.referenceCode })
    },
    filing(row) {
      const id = randomUUID()
      repo.filings.set(id, { id, ...row })
      return Promise.resolve(id)
    },
    evidence(filingId, e) {
      repo.evidence.push({ id: randomUUID(), filingId, ...e })
      return Promise.resolve()
    },
    mailThread(status = "sent") {
      const id = randomUUID()
      repo.mailThreads.set(id, status)
      return Promise.resolve(id)
    },
    mailMessage: () => Promise.resolve(randomUUID()),
    inboundEmail: () => Promise.resolve(randomUUID()),
    setReport(id, patch) {
      const report = repo.reports.get(id)!
      repo.reports.set(id, { ...report, ...patch })
      return Promise.resolve()
    },
    getReport(id) {
      const r = repo.reports.get(id)!
      return Promise.resolve({
        status: r.status,
        deletedAt: r.deletedAt,
        verificationVerdict: r.verificationVerdict,
      })
    },
    timeline: (reportId) =>
      Promise.resolve(
        repo.timeline
          .filter((t) => t.reportId === reportId)
          .map((t) => ({ kind: t.kind, status: t.status, note: t.note, actorId: t.actorId })),
      ),
    audits: () =>
      Promise.resolve(
        repo.audits.map((a) => ({
          action: a.action,
          actorId: a.actorId ?? null,
          target: a.target ?? null,
        })),
      ),
    filingIds: (reportId) =>
      Promise.resolve(
        [...repo.filings.values()].filter((f) => f.reportId === reportId).map((f) => f.id),
      ),
    messageCount: () => Promise.resolve(repo.messages.length),
  }
}

describe("InMemoryFilingRepository", () => {
  defineFilingRepositoryCases(() => Promise.resolve(memoryWorld()))

  it("T60: the memory twin and the Drizzle repository both satisfy FilingRepository", () => {
    const memory: FilingRepository = new InMemoryFilingRepository()
    type Drizzle = ReturnType<typeof makeDrizzleFilingRepository>
    const drizzleIsRepository: Drizzle extends FilingRepository ? true : false = true
    expect(memory).toBeInstanceOf(InMemoryFilingRepository)
    expect(drizzleIsRepository).toBe(true)
  })
})
