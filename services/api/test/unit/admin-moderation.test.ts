import { describe, it, expect } from "vitest"
import { InMemoryModerationRepository } from "../../src/services/admin/moderation-repository.memory.js"
import {
  makeModerationService,
  type ModerationService,
} from "../../src/services/admin/moderation-service.js"

/**
 * Offline unit tests for the admin moderation service over the in-memory ModerationRepository (no DB, no
 * Docker). They cover the queue list (open-only, filter by kind/high, search, paginate), the detail
 * projection (signals/user/similar/media), the actions (approve -> publishes the underlying report;
 * remove -> rejects it; hold -> extends the hold; appeal uphold/overturn a suspension), that an item
 * clears from the queue on any action, and the producer (createItem + dedupe + backfill from held
 * reports).
 */

const NOW = new Date("2026-06-06T00:00:00.000Z")

/** A recording fake for the D-D1 report-chat SYSTEM-message emitter (moderation publish/remove mirror). */
class FakeReportChatEmitter {
  readonly events: { reportId: string; status: string; kind?: string | null; note?: string | null }[] = []
  emit(event: { reportId: string; status: string; kind?: string | null; note?: string | null }): Promise<void> {
    this.events.push(event)
    return Promise.resolve()
  }
}

function harness(): {
  repo: InMemoryModerationRepository
  emitter: FakeReportChatEmitter
  svc: ModerationService
} {
  const repo = new InMemoryModerationRepository()
  repo.now = NOW
  const emitter = new FakeReportChatEmitter()
  const svc = makeModerationService({ repo, now: () => NOW, reportChatEmitter: emitter })
  return { repo, emitter, svc }
}

/** A timestamp `hours` before NOW. */
function hoursAgo(hours: number): Date {
  return new Date(NOW.getTime() - hours * 60 * 60 * 1000)
}

describe("moderation queue list", () => {
  it("projects an open queue row with flag/reporter/category/reason/age/priority/kind", async () => {
    const { repo, svc } = harness()
    repo.seedItem({
      id: "MOD-1",
      kind: "image",
      subjectType: "report",
      flag: "NSFW image",
      reporter: "Anonymous",
      category: "graffiti",
      reason: "nsfw score 0.84",
      priority: "high",
      createdAt: hoursAgo(2),
    })

    const page = await svc.list({})
    expect(page.items).toHaveLength(1)
    const row = page.items[0]!
    expect(row.id).toBe("MOD-1")
    expect(row.flag).toBe("NSFW image")
    expect(row.reporter).toBe("Anonymous")
    expect(row.category).toBe("graffiti")
    expect(row.reason).toBe("nsfw score 0.84")
    expect(row.priority).toBe("high")
    expect(row.kind).toBe("image")
    expect(row.age).toBe("2h")
  })

  it("returns only OPEN items (resolved items never appear)", async () => {
    const { repo, svc } = harness()
    repo.seedItem({ id: "OPEN", status: "open", flag: "a" })
    repo.seedItem({ id: "DONE", status: "approved", flag: "b" })
    repo.seedItem({ id: "HELD", status: "held", flag: "c" })

    const page = await svc.list({})
    expect(page.items.map((i) => i.id)).toEqual(["OPEN"])
  })

  it("filters by kind and by high priority", async () => {
    const { repo, svc } = harness()
    repo.seedItem({ id: "IMG", kind: "image", priority: "med" })
    repo.seedItem({ id: "APP", kind: "appeal", priority: "med" })
    repo.seedItem({ id: "HI", kind: "pattern", priority: "high" })

    expect((await svc.list({ filter: "appeal" })).items.map((i) => i.id)).toEqual(["APP"])
    expect((await svc.list({ filter: "high" })).items.map((i) => i.id)).toEqual(["HI"])
    expect((await svc.list({ filter: "all" })).items).toHaveLength(3)
  })

  it("search matches flag/reporter/reason (case-insensitive)", async () => {
    const { repo, svc } = harness()
    repo.seedItem({ id: "A", flag: "NSFW image", reporter: "Jane", reason: "score high" })
    repo.seedItem({ id: "B", flag: "GPS spoof", reporter: "Bob", reason: "exif delta" })

    expect((await svc.list({ q: "nsfw" })).items.map((i) => i.id)).toEqual(["A"])
    expect((await svc.list({ q: "bob" })).items.map((i) => i.id)).toEqual(["B"])
    expect((await svc.list({ q: "exif" })).items.map((i) => i.id)).toEqual(["B"])
    expect((await svc.list({ q: "nomatch" })).items).toHaveLength(0)
  })

  it("paginates with a cursor (no overlap between pages)", async () => {
    const { repo, svc } = harness()
    for (let i = 0; i < 5; i++) {
      repo.seedItem({ id: `M${i}`, createdAt: hoursAgo(i) })
    }
    const first = await svc.list({ limit: 2 })
    expect(first.items).toHaveLength(2)
    expect(first.nextCursor).not.toBeNull()
    const second = await svc.list({ limit: 2, cursor: first.nextCursor ?? undefined })
    expect(second.items).toHaveLength(2)
    const firstIds = new Set(first.items.map((i) => i.id))
    expect(second.items.every((i) => !firstIds.has(i.id))).toBe(true)
  })
})

describe("moderation detail", () => {
  it("returns desc, autoAction, signals, user, similar, and media", async () => {
    const { repo, svc } = harness()
    repo.seedItem({
      id: "MOD-1",
      kind: "image",
      flag: "NSFW image",
      reporter: "Anonymous",
      category: "hazard",
      reason: "nsfw 0.84",
      desc: "A held photo flagged by the model.",
      autoAction: "Hidden pending review - auto-publishes in 4m",
      place: "Los Angeles, CA",
      signals: [
        { label: "NSFW model", val: "0.84", tone: "bad" },
        { label: "Violence model", val: "0.02", tone: "ok" },
      ],
      similar: [{ id: "REP-9", note: "Same block, resolved as valid", when: "2d" }],
      user: {
        handle: "@anon",
        name: "Anonymous",
        joined: "3d ago",
        priorReports: 1,
        priorRemovals: 0,
        strikes: 0,
        device: "iOS - Los Angeles",
      },
      media: [{ id: "MA-1", kind: "image", url: "/media/x.jpg", thumbUrl: "/media/x-thumb.jpg" }],
    })

    const detail = await svc.getItem("MOD-1")
    expect(detail.desc).toBe("A held photo flagged by the model.")
    expect(detail.autoAction).toContain("auto-publishes")
    expect(detail.place).toBe("Los Angeles, CA")
    expect(detail.signals).toHaveLength(2)
    expect(detail.signals[0]).toEqual({ label: "NSFW model", val: "0.84", tone: "bad" })
    expect(detail.user.handle).toBe("@anon")
    expect(detail.user.priorReports).toBe(1)
    expect(detail.similar[0]).toEqual({
      id: "REP-9",
      note: "Same block, resolved as valid",
      when: "2d",
    })
    expect(detail.media[0]).toEqual({
      id: "MA-1",
      kind: "image",
      url: "/media/x.jpg",
      thumbUrl: "/media/x-thumb.jpg",
    })
  })

  it("substitutes a neutral user snapshot when none was recorded (strict DTO still valid)", async () => {
    const { repo, svc } = harness()
    repo.seedItem({ id: "MOD-1", user: null })
    const detail = await svc.getItem("MOD-1")
    expect(detail.user.name).toBe("Unknown")
    expect(detail.user.strikes).toBe(0)
  })

  it("throws notFound for an unknown item", async () => {
    const { svc } = harness()
    await expect(svc.getItem("nope")).rejects.toMatchObject({ httpStatus: 404 })
  })
})

describe("moderation actions", () => {
  it("approve publishes the underlying report, clears the item, and mirrors a system message into its chat", async () => {
    const { repo, emitter, svc } = harness()
    repo.seedItem({ id: "MOD-1", subjectType: "report", subjectId: "REP-1", status: "open" })

    await svc.approve("MOD-1", { actorId: "op-1", note: null })

    // Item resolved (approved) -> no longer open -> cleared from the queue.
    expect(repo.items.get("MOD-1")?.status).toBe("approved")
    expect((await svc.list({})).items).toHaveLength(0)
    // Underlying report published.
    expect(repo.reportStatus.get("REP-1")).toBe("published")
    // D-D1: exactly one report-chat system event carrying the published status.
    expect(emitter.events).toEqual([
      { reportId: "REP-1", status: "published", kind: "status", note: "Approved in moderation" },
    ])
  })

  it("remove rejects the underlying report, clears the item, and mirrors a system message into its chat", async () => {
    const { repo, emitter, svc } = harness()
    repo.seedItem({ id: "MOD-1", subjectType: "report", subjectId: "REP-1", status: "open" })

    await svc.remove("MOD-1", { actorId: "op-1", reason: "spam" })

    expect(repo.items.get("MOD-1")?.status).toBe("removed")
    expect((await svc.list({})).items).toHaveLength(0)
    expect(repo.reportStatus.get("REP-1")).toBe("rejected")
    // D-D1: exactly one report-chat system event carrying the rejected status + the removal reason note.
    expect(emitter.events).toEqual([
      { reportId: "REP-1", status: "rejected", kind: "remove", note: "spam" },
    ])
  })

  it("remove without a reason mirrors the default 'Removed in moderation' note", async () => {
    const { repo, emitter, svc } = harness()
    repo.seedItem({ id: "MOD-1", subjectType: "report", subjectId: "REP-1", status: "open" })
    await svc.remove("MOD-1", { actorId: "op-1", reason: null })
    expect(emitter.events).toEqual([
      { reportId: "REP-1", status: "rejected", kind: "remove", note: "Removed in moderation" },
    ])
  })

  it("a NON-report subject (e.g. chat) publishes/removes without emitting any report-chat system message", async () => {
    const { repo, emitter, svc } = harness()
    repo.seedItem({ id: "MOD-1", subjectType: "chat", subjectId: "CHAT-1", status: "open" })
    await svc.approve("MOD-1", { actorId: "op-1", note: null })
    expect(emitter.events).toHaveLength(0)
  })

  it("hold extends the hold (item leaves the queue; report not published or rejected)", async () => {
    const { repo, svc } = harness()
    repo.seedItem({ id: "MOD-1", subjectType: "report", subjectId: "REP-1", status: "open" })

    await svc.hold("MOD-1", { actorId: "op-1", note: "need more info" })

    expect(repo.items.get("MOD-1")?.status).toBe("held")
    expect((await svc.list({})).items).toHaveLength(0)
    // Neither published nor rejected.
    expect(repo.reportStatus.has("REP-1")).toBe(false)
  })

  it("appeal uphold keeps the suspension; overturn lifts it; both clear the item", async () => {
    const { repo, svc } = harness()
    repo.seedItem({
      id: "UP",
      kind: "appeal",
      subjectType: "chat",
      subjectId: "CHAT-1",
      status: "open",
    })
    repo.seedItem({
      id: "OV",
      kind: "appeal",
      subjectType: "chat",
      subjectId: "CHAT-2",
      status: "open",
    })

    await svc.appeal("UP", { decision: "uphold", actorId: "op-1", note: null })
    await svc.appeal("OV", { decision: "overturn", actorId: "op-1", note: null })

    // uphold -> suspension stays active (true); overturn -> suspension lifted (false).
    expect(repo.suspensions.get("CHAT-1")).toBe(true)
    expect(repo.suspensions.get("CHAT-2")).toBe(false)
    // Both items resolved (approved) -> cleared from the queue.
    expect(repo.items.get("UP")?.status).toBe("approved")
    expect(repo.items.get("OV")?.status).toBe("approved")
    expect((await svc.list({})).items).toHaveLength(0)
  })

  it("appeal on a non-appeal item is a notFound (kind guard)", async () => {
    const { repo, svc } = harness()
    repo.seedItem({ id: "MOD-1", kind: "image", status: "open" })
    await expect(
      svc.appeal("MOD-1", { decision: "uphold", actorId: null, note: null }),
    ).rejects.toMatchObject({ httpStatus: 404 })
  })

  it("an action on an already-resolved item is a notFound (double-action is safe)", async () => {
    const { repo, svc } = harness()
    repo.seedItem({ id: "MOD-1", status: "approved" })
    await expect(svc.approve("MOD-1", { actorId: null, note: null })).rejects.toMatchObject({
      httpStatus: 404,
    })
  })

  it("an action on an unknown item is a notFound", async () => {
    const { svc } = harness()
    await expect(svc.remove("nope", { actorId: null, reason: null })).rejects.toMatchObject({
      httpStatus: 404,
    })
  })
})

describe("moderation producer", () => {
  it("createItem enqueues an open item that appears in the queue", async () => {
    const { svc } = harness()
    const id = await svc.createItem({
      kind: "image",
      subjectType: "report",
      subjectId: "REP-1",
      flag: "Held report",
      reason: "Awaiting automated review",
      category: "trash",
    })
    expect(id).not.toBeNull()
    const page = await svc.list({})
    expect(page.items).toHaveLength(1)
    expect(page.items[0]?.flag).toBe("Held report")
  })

  it("createItem with dedupeOpen does not double-enqueue for the same open subject", async () => {
    const { svc } = harness()
    const first = await svc.createItem({
      kind: "image",
      subjectType: "report",
      subjectId: "REP-1",
      dedupeOpen: true,
    })
    const second = await svc.createItem({
      kind: "image",
      subjectType: "report",
      subjectId: "REP-1",
      dedupeOpen: true,
    })
    expect(first).not.toBeNull()
    expect(second).toBeNull()
    expect((await svc.list({})).items).toHaveLength(1)
  })

  it("backfill creates one item per held report lacking an open item", async () => {
    const { repo, svc } = harness()
    repo.seedHeldReport({ id: "REP-1", category: "hazard", place: "LA", reporter: "Anon" })
    repo.seedHeldReport({ id: "REP-2", category: "trash", place: "SD", reporter: "Anon" })
    // REP-3 already has an open item -> not backfilled again.
    repo.seedHeldReport({ id: "REP-3" })
    repo.seedItem({ subjectType: "report", subjectId: "REP-3", status: "open" })

    const created = await svc.backfill()
    expect(created).toBe(2)
    const page = await svc.list({ limit: 100 })
    const subjectIds = new Set(
      [...repo.items.values()].filter((i) => i.status === "open").map((i) => i.subjectId),
    )
    expect(subjectIds.has("REP-1")).toBe(true)
    expect(subjectIds.has("REP-2")).toBe(true)
    // The queue now has the 2 backfilled + the 1 pre-existing open item.
    expect(page.items).toHaveLength(3)
  })
})
