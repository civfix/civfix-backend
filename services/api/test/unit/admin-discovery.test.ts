import { describe, it, expect } from "vitest"
import { InMemoryDiscoveryRepository } from "../../src/services/admin/discovery-repository.memory.js"
import {
  makeDiscoveryService,
  computeContactState,
  derivePriority,
  dominantCategory,
  fullPerCategoryCounts,
  isOverSla,
  DISCOVERY_SLA_HOURS,
  type DiscoveryService,
} from "../../src/services/admin/discovery-service.js"

/**
 * Offline unit tests for the admin discovery service over the in-memory DiscoveryRepository (no DB, no
 * Docker). They cover the queue list (filter all|attention|clear + sort pop|reports + search), the
 * detail projection (per-category counts + contacts + sample pins), and the note / flag / draft
 * mutations, plus the pure helpers (dominant category, contact state, SLA, priority band).
 */

const NOW = new Date("2026-06-06T00:00:00.000Z")

function harness(): { repo: InMemoryDiscoveryRepository; svc: DiscoveryService } {
  const repo = new InMemoryDiscoveryRepository()
  // Anchor the repo's note clock to NOW so a freshly added note renders "now" against the service ref.
  repo.now = NOW
  const svc = makeDiscoveryService({ repo, now: () => NOW })
  return { repo, svc }
}

/** A timestamp `hours` before NOW. */
function hoursAgo(hours: number): Date {
  return new Date(NOW.getTime() - hours * 60 * 60 * 1000)
}

describe("discovery pure helpers", () => {
  it("fullPerCategoryCounts fills every category with 0 by default", () => {
    expect(fullPerCategoryCounts({ trash: 3 })).toEqual({
      trash: 3,
      recycling: 0,
      graffiti: 0,
      hazard: 0,
      water: 0,
      other: 0,
    })
  })

  it("dominantCategory returns the most-waited category (ties -> canonical order)", () => {
    expect(dominantCategory({ trash: 2, hazard: 5 })).toBe("hazard")
    expect(dominantCategory({ trash: 2, recycling: 2 })).toBe("trash")
    expect(dominantCategory({})).toBe("other")
  })

  it("isOverSla breaches only past the SLA window", () => {
    expect(isOverSla(hoursAgo(DISCOVERY_SLA_HOURS + 1), NOW)).toBe(true)
    expect(isOverSla(hoursAgo(DISCOVERY_SLA_HOURS - 1), NOW)).toBe(false)
    expect(isOverSla(null, NOW)).toBe(false)
  })

  it("derivePriority: over-SLA -> high, waiting -> med, idle -> low", () => {
    const base = {
      id: "t",
      geoid: "g",
      place: "P",
      layer: "place" as const,
      population: 1,
      status: "open",
      perCategory: {},
      total: 0,
      oldestWaitingAt: null as Date | null,
      newestWaitingAt: null as Date | null,
      contactCategories: [],
      hasDefaultContact: false,
    }
    expect(derivePriority({ ...base, total: 0 }, NOW)).toBe("low")
    expect(derivePriority({ ...base, total: 2, oldestWaitingAt: hoursAgo(2) }, NOW)).toBe("med")
    expect(
      derivePriority({ ...base, total: 2, oldestWaitingAt: hoursAgo(DISCOVERY_SLA_HOURS + 5) }, NOW),
    ).toBe("high")
  })

  it("computeContactState: a waiting category with no contact is missing; a routed one is routed", () => {
    const state = computeContactState({
      id: "t",
      geoid: "g",
      place: "P",
      layer: "place" as const,
      population: 1,
      status: "open",
      perCategory: { trash: 2, hazard: 1 },
      total: 3,
      oldestWaitingAt: hoursAgo(1),
      newestWaitingAt: hoursAgo(1),
      contactCategories: ["trash"],
      hasDefaultContact: false,
    })
    expect(state.routed).toContain("trash")
    expect(state.missing).toContain("hazard")
    expect(state.missing).not.toContain("trash")
  })
})

describe("discovery list", () => {
  it("projects a queue row with dominant category, counts, age + SLA labels", async () => {
    const { repo, svc } = harness()
    repo.seedTask({
      id: "JUR-1",
      geoid: "0644000",
      place: "Los Angeles",
      population: 3_900_000,
      perCategory: { trash: 4, hazard: 2 },
      oldestWaitingAt: hoursAgo(DISCOVERY_SLA_HOURS + 3),
      newestWaitingAt: hoursAgo(1),
    })

    const page = await svc.list({})
    expect(page.items).toHaveLength(1)
    const row = page.items[0]!
    expect(row.id).toBe("JUR-1")
    expect(row.place).toBe("Los Angeles")
    expect(row.category).toBe("trash") // dominant (4 > 2)
    expect(row.catLabel).toBe("Trash")
    expect(row.pop).toBe(3_900_000)
    expect(row.reports).toBe(6)
    expect(row.perCategoryCounts.trash).toBe(4)
    expect(row.perCategoryCounts.hazard).toBe(2)
    expect(row.perCategoryCounts.water).toBe(0)
    expect(row.overSla).toBe(true)
    expect(row.priority).toBe("high")
    expect(row.lastReport).toBe("1h")
    // No contacts on file + waiting reports -> both categories missing.
    expect(row.contactState.missing).toEqual(expect.arrayContaining(["trash", "hazard"]))
  })

  it("sorts by population desc by default and by reports when asked", async () => {
    const { repo, svc } = harness()
    repo.seedTask({ id: "A", geoid: "1", place: "Alpha", population: 100, perCategory: { trash: 9 } })
    repo.seedTask({ id: "B", geoid: "2", place: "Bravo", population: 900, perCategory: { trash: 1 } })

    const byPop = await svc.list({ sort: "pop" })
    expect(byPop.items.map((i) => i.id)).toEqual(["B", "A"])

    const byReports = await svc.list({ sort: "reports" })
    expect(byReports.items.map((i) => i.id)).toEqual(["A", "B"])
  })

  it("filters attention (missing contact) vs clear (fully routed)", async () => {
    const { repo, svc } = harness()
    // Needs attention: waiting trash, no contact.
    repo.seedTask({ id: "ATTN", geoid: "1", place: "Needs", perCategory: { trash: 3 } })
    // Clear: waiting trash but a default contact covers it.
    repo.seedTask({
      id: "CLEAR",
      geoid: "2",
      place: "Routed",
      perCategory: { trash: 3 },
      hasDefaultContact: true,
    })

    const attention = await svc.list({ filter: "attention" })
    expect(attention.items.map((i) => i.id)).toEqual(["ATTN"])

    const clear = await svc.list({ filter: "clear" })
    expect(clear.items.map((i) => i.id)).toEqual(["CLEAR"])

    const all = await svc.list({ filter: "all" })
    expect(all.items).toHaveLength(2)
  })

  it("search matches place or id (case-insensitive)", async () => {
    const { repo, svc } = harness()
    repo.seedTask({ id: "JUR-1", geoid: "1", place: "Los Angeles", perCategory: { trash: 1 } })
    repo.seedTask({ id: "JUR-2", geoid: "2", place: "San Diego", perCategory: { trash: 1 } })

    expect((await svc.list({ q: "angeles" })).items.map((i) => i.id)).toEqual(["JUR-1"])
    expect((await svc.list({ q: "jur-2" })).items.map((i) => i.id)).toEqual(["JUR-2"])
    expect((await svc.list({ q: "nomatch" })).items).toHaveLength(0)
  })

  it("paginates with a cursor", async () => {
    const { repo, svc } = harness()
    for (let i = 0; i < 5; i++) {
      repo.seedTask({ id: `T${i}`, geoid: `${i}`, place: `Place ${i}`, population: 100 - i })
    }
    const first = await svc.list({ limit: 2 })
    expect(first.items).toHaveLength(2)
    expect(first.nextCursor).not.toBeNull()
    const second = await svc.list({ limit: 2, cursor: first.nextCursor ?? undefined })
    expect(second.items).toHaveLength(2)
    // No overlap between pages.
    const firstIds = new Set(first.items.map((i) => i.id))
    expect(second.items.every((i) => !firstIds.has(i.id))).toBe(true)
  })
})

describe("discovery detail", () => {
  it("returns the task + existing contacts + sample pins + center/zoom", async () => {
    const { repo, svc } = harness()
    repo.seedTask({
      id: "JUR-1",
      geoid: "0644000",
      place: "Los Angeles",
      population: 100,
      perCategory: { trash: 2 },
      oldestWaitingAt: hoursAgo(2),
      newestWaitingAt: hoursAgo(1),
      contacts: [{ category: "trash", email: "trash@lacity.gov" }],
      samplePins: [{ category: "trash", lat: 34.05, lng: -118.24 }],
      center: [34.05, -118.24],
      zoom: 11,
    })

    const detail = await svc.getTask("JUR-1")
    expect(detail.id).toBe("JUR-1")
    expect(detail.contacts).toEqual([{ category: "trash", email: "trash@lacity.gov" }])
    expect(detail.samplePins).toEqual([
      { category: "trash", lat: 34.05, lng: -118.24, draft: false },
    ])
    expect(detail.center).toEqual([34.05, -118.24])
    expect(detail.zoom).toBe(11)
  })

  it("throws notFound for an unknown task", async () => {
    const { svc } = harness()
    await expect(svc.getTask("nope")).rejects.toMatchObject({ httpStatus: 404 })
  })

  it("surfaces citizen contact suggestions (by geoid) as Reporter notes in the detail", async () => {
    const { repo, svc } = harness()
    repo.seedTask({ id: "JUR-1", geoid: "4805000", place: "Austin", perCategory: { trash: 1 } })
    repo.seedSuggestion("4805000", { email: "311@austintexas.gov", note: "ask for the SR desk" })

    const detail = await svc.getTask("JUR-1")
    const reporterNotes = detail.notes.filter((n) => n.who === "Reporter")
    expect(reporterNotes).toHaveLength(1)
    expect(reporterNotes[0]?.text).toContain("311@austintexas.gov")
    expect(reporterNotes[0]?.text).toContain("ask for the SR desk")
  })

  it("interleaves operator notes and citizen suggestions oldest-first", async () => {
    const { repo, svc } = harness()
    repo.seedTask({ id: "JUR-1", geoid: "4805000", place: "Austin", perCategory: { trash: 1 } })
    // Suggestion lands first (earlier clock tick), then an operator note.
    repo.seedSuggestion("4805000", { formUrl: "https://austin.gov/report" })
    await svc.addNote("JUR-1", { text: "Verified the form", actorId: "op", who: "jane" })

    const detail = await svc.getTask("JUR-1")
    expect(detail.notes.map((n) => n.who)).toEqual(["Reporter", "jane"])
  })
})

describe("discovery mutations", () => {
  it("addNote appends a note returned with a relative when label, and surfaced in detail", async () => {
    const { repo, svc } = harness()
    repo.seedTask({ id: "JUR-1", geoid: "1", place: "LA", perCategory: { trash: 1 } })

    const note = await svc.addNote("JUR-1", { text: "Called the clerk", actorId: "op-1", who: "jane" })
    expect(note.text).toBe("Called the clerk")
    expect(note.who).toBe("jane")
    expect(note.when).toBe("now")

    const detail = await svc.getTask("JUR-1")
    expect(detail.notes).toHaveLength(1)
    expect(detail.notes[0]?.text).toBe("Called the clerk")
  })

  it("addNote throws notFound for an unknown task", async () => {
    const { svc } = harness()
    await expect(
      svc.addNote("nope", { text: "x", actorId: null, who: "op" }),
    ).rejects.toMatchObject({ httpStatus: 404 })
  })

  it("flag marks the task in_progress", async () => {
    const { repo, svc } = harness()
    repo.seedTask({ id: "JUR-1", geoid: "1", place: "LA", perCategory: { trash: 1 } })
    await svc.flag("JUR-1", { reason: "looks off", actorId: "op-1" })
    expect(repo.tasks.get("JUR-1")?.task.status).toBe("in_progress")
  })

  it("flag throws notFound for an unknown task", async () => {
    const { svc } = harness()
    await expect(svc.flag("nope", { reason: null, actorId: null })).rejects.toMatchObject({
      httpStatus: 404,
    })
  })

  it("saveDraft upserts per-category contacts without routing", async () => {
    const { repo, svc } = harness()
    repo.seedTask({ id: "JUR-1", geoid: "1", place: "LA", perCategory: { trash: 1, hazard: 1 } })

    await svc.saveDraft("JUR-1", {
      contacts: { trash: "trash@city.gov" },
      defaultEmails: [],
      formUrl: null,
      actorId: "op-1",
    })

    const detail = await svc.getTask("JUR-1")
    expect(detail.contacts).toContainEqual({ category: "trash", email: "trash@city.gov" })
    // Draft does NOT resolve the task.
    expect(repo.tasks.get("JUR-1")?.task.status).toBe("open")
    // trash now routed; hazard still missing.
    expect(detail.contactState.routed).toContain("trash")
    expect(detail.contactState.missing).toContain("hazard")
  })

  it("saveDraft throws notFound for an unknown task", async () => {
    const { svc } = harness()
    await expect(
      svc.saveDraft("nope", { contacts: {}, defaultEmails: [], formUrl: null, actorId: null }),
    ).rejects.toMatchObject({ httpStatus: 404 })
  })
})
