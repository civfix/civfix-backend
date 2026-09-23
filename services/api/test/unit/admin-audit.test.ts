import { describe, it, expect } from "vitest"
import { InMemoryAuditRepository } from "../../src/services/admin/audit-repository.memory.js"
import {
  makeAuditService,
  toAuditEntryDTO,
  type AuditService,
} from "../../src/services/admin/audit-service.js"

const NOW = new Date("2026-06-15T12:00:00.000Z")

function harness(): { repo: InMemoryAuditRepository; svc: AuditService } {
  const repo = new InMemoryAuditRepository()
  const svc = makeAuditService({ repo })
  return { repo, svc }
}

function minutesAgo(m: number): Date {
  return new Date(NOW.getTime() - m * 60 * 1000)
}

describe("toAuditEntryDTO", () => {
  it("projects a row, defaulting null target/meta", () => {
    const dto = toAuditEntryDTO({
      id: "11111111-1111-1111-1111-111111111111",
      actorId: "22222222-2222-2222-2222-222222222222",
      actorName: "Operator A",
      action: "user.banned",
      target: null,
      meta: null,
      createdAt: NOW,
    })
    expect(dto.id).toBe("11111111-1111-1111-1111-111111111111")
    expect(dto.actorId).toBe("22222222-2222-2222-2222-222222222222")
    expect(dto.actorName).toBe("Operator A")
    expect(dto.action).toBe("user.banned")
    expect(dto.target).toBe("")
    expect(dto.meta).toEqual({})
    expect(dto.createdAt).toBe(NOW.toISOString())
  })

  it("keeps a present target + meta", () => {
    const dto = toAuditEntryDTO({
      id: "1",
      actorId: null,
      actorName: null,
      action: "report.status_changed",
      target: "report:abc",
      meta: { from: "submitted", to: "in_progress" },
      createdAt: NOW,
    })
    expect(dto.target).toBe("report:abc")
    expect(dto.meta).toEqual({ from: "submitted", to: "in_progress" })
    expect(dto.actorId).toBeNull()
  })
})

describe("audit list", () => {
  it("returns rows newest-first, projected to DTOs", async () => {
    const { repo, svc } = harness()
    repo.seedRow({ id: "a", action: "report.flagged", createdAt: minutesAgo(10) })
    repo.seedRow({ id: "b", action: "user.banned", createdAt: minutesAgo(1) })

    const page = await svc.list({})
    expect(page.items.map((i) => i.action)).toEqual(["user.banned", "report.flagged"])
  })

  it("filters by action (case-insensitive substring)", async () => {
    const { repo, svc } = harness()
    repo.seedRow({ id: "a", action: "report.status_changed" })
    repo.seedRow({ id: "b", action: "user.banned" })

    const page = await svc.list({ action: "USER" })
    expect(page.items.map((i) => i.action)).toEqual(["user.banned"])
  })

  it("filters by target (case-insensitive substring)", async () => {
    const { repo, svc } = harness()
    repo.seedRow({ id: "a", action: "x", target: "report:111" })
    repo.seedRow({ id: "b", action: "y", target: "gov_claim:222" })

    const page = await svc.list({ target: "gov_claim" })
    expect(page.items.map((i) => i.target)).toEqual(["gov_claim:222"])
  })

  it("filters by actor (matches actor name substring OR exact actor id)", async () => {
    const { repo, svc } = harness()
    repo.seedRow({ id: "a", actorId: "op-1", actorName: "Alice Operator", action: "x" })
    repo.seedRow({ id: "b", actorId: "op-2", actorName: "Bob Operator", action: "y" })

    expect((await svc.list({ actor: "alice" })).items.map((i) => i.action)).toEqual(["x"])
    expect((await svc.list({ actor: "op-2" })).items.map((i) => i.action)).toEqual(["y"])
  })

  it("paginates with a cursor (no overlap between pages)", async () => {
    const { repo, svc } = harness()
    for (let i = 0; i < 5; i++) {
      repo.seedRow({ id: `r${i}`, action: "x", createdAt: minutesAgo(i) })
    }
    const first = await svc.list({ limit: 2 })
    expect(first.items).toHaveLength(2)
    expect(first.nextCursor).not.toBeNull()
    const second = await svc.list({ limit: 2, cursor: first.nextCursor ?? undefined })
    const firstIds = new Set(first.items.map((i) => i.id))
    expect(second.items.every((i) => !firstIds.has(i.id))).toBe(true)
    expect(second.items).toHaveLength(2)
  })

  it("blank filters are ignored (return everything)", async () => {
    const { repo, svc } = harness()
    repo.seedRow({ id: "a", action: "x" })
    repo.seedRow({ id: "b", action: "y" })
    const page = await svc.list({ actor: "  ", action: "", target: undefined })
    expect(page.items).toHaveLength(2)
  })
})
