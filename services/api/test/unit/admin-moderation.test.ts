import { describe, it, expect } from "vitest"
import { InMemoryModerationRepository } from "../../src/services/admin/moderation-repository.memory.js"
import {
  makeModerationService,
  type ModerationService,
} from "../../src/services/admin/moderation-service.js"
import type { UserStatus } from "@civfix/shared"


const NOW = new Date("2026-06-06T00:00:00.000Z")

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

  it("filters by the user_report kind", async () => {
    const { repo, svc } = harness()
    repo.seedItem({ id: "UR1", kind: "user_report", subjectType: "user", priority: "med" })
    repo.seedItem({ id: "UR2", kind: "user_report", subjectType: "profile", priority: "high" })
    repo.seedItem({ id: "IMG", kind: "image", priority: "med" })
    repo.seedItem({ id: "DUP", kind: "duplicate", priority: "med" })

    expect((await svc.list({ filter: "user_report" })).items.map((i) => i.id).sort()).toEqual([
      "UR1",
      "UR2",
    ])
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

  it("keeps paging after page 1 has been RESOLVED (keyset tuple, not an index lookup)", async () => {
    const { repo, svc } = harness()
    for (let i = 0; i < 5; i++) {
      repo.seedItem({ id: `M${i}`, createdAt: hoursAgo(i) })
    }
    const first = await svc.list({ limit: 2 })
    expect(first.items.map((i) => i.id)).toEqual(["M0", "M1"])
    const cursor = first.nextCursor
    expect(cursor).not.toBeNull()

    await svc.approve("M0", { actorId: "op-1", note: null })
    await svc.remove("M1", { actorId: "op-1", reason: null })
    expect(repo.items.get("M1")?.status).toBe("removed")

    const second = await svc.list({ limit: 2, cursor: cursor ?? undefined })
    expect(second.items.map((i) => i.id)).toEqual(["M2", "M3"])
    expect(second.nextCursor).not.toBeNull()

    const third = await svc.list({ limit: 2, cursor: second.nextCursor ?? undefined })
    expect(third.items.map((i) => i.id)).toEqual(["M4"])
    expect(third.nextCursor).toBeNull()
  })

  it("pages deterministically when several items share a createdAt (id is the tiebreak)", async () => {
    const { repo, svc } = harness()
    const sameTime = hoursAgo(3)
    for (const id of ["A", "B", "C"]) repo.seedItem({ id, createdAt: sameTime })

    const first = await svc.list({ limit: 2 })
    expect(first.items.map((i) => i.id)).toEqual(["C", "B"])
    const second = await svc.list({ limit: 2, cursor: first.nextCursor ?? undefined })
    expect(second.items.map((i) => i.id)).toEqual(["A"])
    expect(second.nextCursor).toBeNull()
  })

  it("keeps chat/photo subject ids and exposes only repository-backed admin destinations", async () => {
    const { repo, svc } = harness()
    repo.seedItem({
      id: "CHAT",
      subjectType: "chat",
      subjectId: "CHAT-MESSAGE-1",
      destinationKind: "event",
      destinationId: "EVENT-1",
    })
    repo.seedItem({
      id: "PHOTO",
      subjectType: "photo",
      subjectId: "MEDIA-1",
      destinationKind: "report",
      destinationId: "REPORT-1",
    })
    repo.seedItem({
      id: "ORPHAN",
      subjectType: "chat",
      subjectId: "GROUP-MESSAGE-1",
      destinationKind: null,
      destinationId: null,
    })

    const rows = (await svc.list({ limit: 10 })).items
    expect(rows.find((row) => row.id === "CHAT")).toMatchObject({
      subjectId: "CHAT-MESSAGE-1",
      destinationKind: "event",
      destinationId: "EVENT-1",
    })
    expect(rows.find((row) => row.id === "PHOTO")).toMatchObject({
      subjectId: "MEDIA-1",
      destinationKind: "report",
      destinationId: "REPORT-1",
    })
    expect(rows.find((row) => row.id === "ORPHAN")).toMatchObject({
      subjectId: "GROUP-MESSAGE-1",
      destinationKind: null,
      destinationId: null,
    })
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
      reporterId: "REPORTER-9",
      user: {
        id: "USER-1",
        handle: "@anon",
        name: "Anonymous",
        joined: "3d ago",
        priorReports: 1,
        priorRemovals: 0,
        strikes: 0,
        device: "iOS - Los Angeles",
      },
      media: [{ id: "MA-1", kind: "image", r2Key: "reports/x.jpg", thumbKey: "reports/x-thumb.jpg" }],
    })

    const detail = await svc.getItem("MOD-1")
    expect(detail.desc).toBe("A held photo flagged by the model.")
    expect(detail.autoAction).toContain("auto-publishes")
    expect(detail.place).toBe("Los Angeles, CA")
    expect(detail.signals).toHaveLength(2)
    expect(detail.signals[0]).toEqual({ label: "NSFW model", val: "0.84", tone: "bad" })
    expect(detail.user.handle).toBe("@anon")
    expect(detail.user.id).toBe("USER-1")
    expect(detail.reporterId).toBe("REPORTER-9")
    expect(detail.user.priorReports).toBe(1)
    expect(detail.similar[0]).toEqual({
      id: "REP-9",
      note: "Same block, resolved as valid",
      when: "2d",
    })
    expect(detail.media[0]).toEqual({
      id: "MA-1",
      kind: "image",
      url: "reports/x.jpg",
      thumbUrl: "reports/x-thumb.jpg",
    })
  })

  it("presigns held media over the injected presigner (F007: never a raw key or public CDN URL)", async () => {
    const repo = new InMemoryModerationRepository()
    repo.now = NOW
    const seen: Array<[string, string | null]> = []
    const svc = makeModerationService({
      repo,
      now: () => NOW,
      presignMedia: async (r2Key: string, thumbKey: string | null) => {
        seen.push([r2Key, thumbKey])
        return thumbKey === null
          ? { url: `signed:${r2Key}` }
          : { url: `signed:${r2Key}`, thumbUrl: `signed:${thumbKey}` }
      },
    })
    repo.seedItem({
      id: "MOD-P",
      kind: "image",
      media: [{ id: "MA-2", kind: "image", r2Key: "reports/held.jpg", thumbKey: "reports/held-t.jpg" }],
    })
    const detail = await svc.getItem("MOD-P")
    expect(detail.media[0]).toEqual({
      id: "MA-2",
      kind: "image",
      url: "signed:reports/held.jpg",
      thumbUrl: "signed:reports/held-t.jpg",
    })
    expect(seen).toEqual([["reports/held.jpg", "reports/held-t.jpg"]])
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

    expect(repo.items.get("MOD-1")?.status).toBe("approved")
    expect((await svc.list({})).items).toHaveLength(0)
    expect(repo.reportStatus.get("REP-1")).toBe("published")
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

    expect(repo.suspensions.get("CHAT-1")).toBe(true)
    expect(repo.suspensions.get("CHAT-2")).toBe(false)
    expect(repo.items.get("UP")?.status).toBe("approved")
    expect(repo.items.get("OV")?.status).toBe("approved")
    expect((await svc.list({})).items).toHaveLength(0)
  })

  it("appeal overturn undoes the moderation action; uphold leaves it standing (F115)", async () => {
    const { repo, svc } = harness()
    repo.seedItem({ id: "MOD-C", subjectType: "chat", subjectId: "CHAT-9", status: "open" })
    repo.seedItem({ id: "MOD-U", subjectType: "user", subjectId: "USER-9", status: "open" })
    await svc.remove("MOD-C", { actorId: "op-1", reason: "abuse" })
    await svc.remove("MOD-U", { actorId: "op-1", reason: "abuse" })
    expect(repo.tombstoned.has("CHAT-9")).toBe(true)
    expect(repo.accountStatus.get("USER-9")).toBe("suspended")

    repo.seedItem({
      id: "APP-KEEP",
      kind: "appeal",
      subjectType: "chat",
      subjectId: "CHAT-9",
      status: "open",
    })
    await svc.appeal("APP-KEEP", { decision: "uphold", actorId: "op-1", note: null })
    expect(repo.tombstoned.has("CHAT-9")).toBe(true)

    repo.seedItem({
      id: "APP-LIFT",
      kind: "appeal",
      subjectType: "chat",
      subjectId: "CHAT-9",
      status: "open",
    })
    repo.seedItem({
      id: "APP-USER",
      kind: "appeal",
      subjectType: "user",
      subjectId: "USER-9",
      status: "open",
    })
    await svc.appeal("APP-LIFT", { decision: "overturn", actorId: "op-1", note: null })
    await svc.appeal("APP-USER", { decision: "overturn", actorId: "op-1", note: null })

    expect(repo.tombstoned.has("CHAT-9")).toBe(false)
    expect(repo.accountStatus.get("USER-9")).toBe("active")
  })

  it("H4: removing a USER subject suspends the account AND revokes every session", async () => {
    const repo = new InMemoryModerationRepository()
    repo.now = NOW
    const applied: Array<{ userId: string; status: UserStatus }> = []
    const svc = makeModerationService({
      repo,
      now: () => NOW,
      sessions: {
        applyStatus: (userId: string, status: UserStatus) => {
          applied.push({ userId, status })
          return Promise.resolve(1)
        },
      },
    })

    repo.seedItem({ id: "MOD-U", subjectType: "user", subjectId: "USER-9", status: "open" })
    await svc.remove("MOD-U", { actorId: "op-1", reason: "abuse" })

    expect(repo.accountStatus.get("USER-9")).toBe("suspended")
    expect(applied).toEqual([{ userId: "USER-9", status: "suspended" }])
  })

  it("H4: removing a non-user subject never touches the account status", async () => {
    const repo = new InMemoryModerationRepository()
    repo.now = NOW
    const applied: Array<{ userId: string; status: UserStatus }> = []
    const svc = makeModerationService({
      repo,
      now: () => NOW,
      sessions: {
        applyStatus: (userId: string, status: UserStatus) => {
          applied.push({ userId, status })
          return Promise.resolve(1)
        },
      },
    })

    repo.seedItem({ id: "MOD-C", subjectType: "chat", subjectId: "CHAT-7", status: "open" })
    await svc.remove("MOD-C", { actorId: "op-1", reason: "abuse" })

    expect(applied).toEqual([])
  })

  it("appeal overturn on a USER lifts the Redis ban marker, exactly like an admin status change", async () => {
    const repo = new InMemoryModerationRepository()
    repo.now = NOW
    const cleared: string[] = []
    const svc = makeModerationService({
      repo,
      now: () => NOW,
      sessions: {
        applyStatus: (userId: string, status: UserStatus) => {
          if (status === "active") cleared.push(userId)
          return Promise.resolve(0)
        },
      },
    })

    repo.seedItem({ id: "MOD-U", subjectType: "user", subjectId: "USER-9", status: "open" })
    await svc.remove("MOD-U", { actorId: "op-1", reason: "abuse" })
    repo.seedItem({ id: "APP-U", kind: "appeal", subjectType: "user", subjectId: "USER-9", status: "open" })

    await svc.appeal("APP-U", { decision: "overturn", actorId: "op-1", note: null })

    expect(cleared).toEqual(["USER-9"])
    expect(repo.accountStatus.get("USER-9")).toBe("active")
  })

  it("appeal uphold, a non-user subject, and a refused restore never touch the ban marker", async () => {
    const repo = new InMemoryModerationRepository()
    repo.now = NOW
    const cleared: string[] = []
    const svc = makeModerationService({
      repo,
      now: () => NOW,
      sessions: {
        applyStatus: (userId: string, status: UserStatus) => {
          if (status === "active") cleared.push(userId)
          return Promise.resolve(0)
        },
      },
    })

    repo.seedItem({ id: "APP-KEEP", kind: "appeal", subjectType: "user", subjectId: "USER-1", status: "open" })
    await svc.appeal("APP-KEEP", { decision: "uphold", actorId: "op-1", note: null })

    repo.seedItem({ id: "APP-CHAT", kind: "appeal", subjectType: "chat", subjectId: "CHAT-1", status: "open" })
    await svc.appeal("APP-CHAT", { decision: "overturn", actorId: "op-1", note: null })

    repo.deletedUserIds.add("USER-GONE")
    repo.seedItem({ id: "APP-GONE", kind: "appeal", subjectType: "user", subjectId: "USER-GONE", status: "open" })
    await svc.appeal("APP-GONE", { decision: "overturn", actorId: "op-1", note: null })

    expect(cleared).toEqual([])
    expect(repo.accountStatus.get("USER-GONE")).toBeUndefined()
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

  it("createItem threads the flagging reporter's id (reporterUserId) into reporterId, distinct from the subject author", async () => {
    const { svc } = harness()
    const id = await svc.createItem({
      kind: "user_report",
      subjectType: "report",
      subjectId: "REP-1",
      flag: "User report",
      reporter: "@flagger",
      reporterUserId: "FLAGGER-1",
      user: {
        id: "AUTHOR-1",
        handle: "@author",
        name: "Author",
        joined: "",
        priorReports: 0,
        priorRemovals: 0,
        strikes: 0,
        device: "",
      },
    })
    expect(id).not.toBeNull()

    const row = (await svc.list({})).items[0]!
    expect(row.reporter).toBe("@flagger")
    expect(row.reporterId).toBe("FLAGGER-1")

    const detail = await svc.getItem(id!)
    expect(detail.user.id).toBe("AUTHOR-1")
    expect(detail.reporterId).toBe("FLAGGER-1")
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

  it("F149: a deduped report escalates the existing open item's priority instead of being silently dropped", async () => {
    const { repo, svc } = harness()
    const id = await svc.createItem({
      kind: "image",
      subjectType: "report",
      subjectId: "REP-9",
      priority: "med",
      dedupeOpen: true,
    })
    expect(repo.items.get(id!)?.priority).toBe("med")
    const second = await svc.createItem({
      kind: "image",
      subjectType: "report",
      subjectId: "REP-9",
      priority: "med",
      reporterUserId: "USER-2",
      dedupeOpen: true,
    })
    expect(second).toBeNull()
    expect(repo.items.get(id!)?.priority).toBe("high")
  })

  it("backfill creates one item per held report lacking an open item", async () => {
    const { repo, svc } = harness()
    repo.seedHeldReport({ id: "REP-1", category: "hazard", place: "LA", reporter: "Anon" })
    repo.seedHeldReport({ id: "REP-2", category: "trash", place: "SD", reporter: "Anon" })
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
    expect(page.items).toHaveLength(3)
  })
})
