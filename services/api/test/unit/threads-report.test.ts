import { describe, it, expect } from "vitest"
import {
  makeThreadsService,
  InMemoryChatReadState,
  type ReportThreadsSource,
  type ReportThreadAggregateView,
  type ThreadsMutesSource,
} from "../../src/services/threads-service.js"
import { InMemoryThreadsRepository } from "../helpers/chat.js"

const ME = "11111111-1111-1111-1111-111111111111"
const OTHER = "22222222-2222-2222-2222-222222222222"
const REPORT_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
const CLEANUP_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc"

const NOW = new Date("2026-06-01T12:00:00.000Z")

function reportSource(rows: ReportThreadAggregateView[]): ReportThreadsSource {
  return { listReportThreadsFor: () => Promise.resolve(rows) }
}

function mutesSource(muted: Array<{ roomKind: "cleanup" | "dm" | "report"; roomId: string }>): {
  source: ThreadsMutesSource
  calls: Array<{ roomKind: string; roomIds: string[] }>
} {
  const set = new Set(muted.map((m) => `${m.roomKind}:${m.roomId}`))
  const calls: Array<{ roomKind: string; roomIds: string[] }> = []
  return {
    calls,
    source: {
      mutedRoomIdsFor: (_userId, roomKind, roomIds) => {
        calls.push({ roomKind, roomIds })
        return Promise.resolve(new Set(roomIds.filter((id) => set.has(`${roomKind}:${id}`))))
      },
    },
  }
}

describe("threads service — report half (DB-free)", () => {
  it("projects a report aggregate into a kind:'report' DTO with muted:false by default", async () => {
    const report: ReportThreadAggregateView = {
      reportId: REPORT_A,
      title: "Trash - 123 Main St",
      members: 1,
      unread: 1,
      joinedAt: new Date("2026-06-01T09:00:00.000Z"),
      last: {
        body: "please look at this",
        createdAt: new Date("2026-06-01T11:30:00.000Z"),
        senderId: OTHER,
      },
    }
    const svc = makeThreadsService({
      repo: new InMemoryThreadsRepository(),
      readState: new InMemoryChatReadState(),
      report: reportSource([report]),
      now: () => NOW,
    })
    const { items } = await svc.listThreads(ME)
    expect(items).toHaveLength(1)
    const t = items[0]!
    expect(t.kind).toBe("report")
    expect(t.id).toBe(REPORT_A)
    expect(t.refId).toBe(REPORT_A)
    expect(t.title).toBe("Trash - 123 Main St")
    expect(t.last).toBe("please look at this")
    expect(t.ago).toBe("30m")
    expect(t.lastMessageAt).toBe("2026-06-01T11:30:00.000Z")
    expect(t.lastFromMe).toBe(false)
    expect(t.unread).toBe(1)
    expect(t.members).toBe(1)
    expect(t.muted).toBe(false)
  })

  it("treats a system message (senderId null) as NOT from me", async () => {
    const report: ReportThreadAggregateView = {
      reportId: REPORT_A,
      title: "Hazard",
      members: 1,
      unread: 1,
      joinedAt: new Date("2026-06-01T09:00:00.000Z"),
      last: {
        body: "Report was acknowledged.",
        createdAt: new Date("2026-06-01T11:00:00.000Z"),
        senderId: null,
      },
    }
    const svc = makeThreadsService({
      repo: new InMemoryThreadsRepository(),
      readState: new InMemoryChatReadState(),
      report: reportSource([report]),
      now: () => NOW,
    })
    const t = (await svc.listThreads(ME)).items[0]!
    expect(t.lastFromMe).toBe(false)
    expect(t.last).toBe("Report was acknowledged.")
  })

  it("an empty report room (no last message) has null last/ago and sorts on joinedAt", async () => {
    const report: ReportThreadAggregateView = {
      reportId: REPORT_A,
      title: "Water",
      members: 2,
      unread: 0,
      joinedAt: new Date("2026-06-01T10:00:00.000Z"),
      last: null,
    }
    const svc = makeThreadsService({
      repo: new InMemoryThreadsRepository(),
      readState: new InMemoryChatReadState(),
      report: reportSource([report]),
      now: () => NOW,
    })
    const t = (await svc.listThreads(ME)).items[0]!
    expect(t.last).toBeNull()
    expect(t.ago).toBeNull()
    expect(t.lastMessageAt).toBeNull()
    expect(t.unread).toBe(0)
    expect(t.muted).toBe(false)
  })

  it("merges report entries with cleanup entries, most-recent-activity first", async () => {
    const repo = new InMemoryThreadsRepository()
    const c1 = repo.seedCleanup("Beach sweep", CLEANUP_ID)
    repo.addMember(c1, ME, new Date("2026-06-01T08:00:00.000Z"))
    repo.addMessage(c1, {
      senderId: OTHER,
      body: "older cleanup msg",
      createdAt: new Date("2026-06-01T09:00:00.000Z"),
    })

    const report: ReportThreadAggregateView = {
      reportId: REPORT_A,
      title: "Graffiti - Elm Ave",
      members: 1,
      unread: 1,
      joinedAt: new Date("2026-06-01T08:00:00.000Z"),
      last: {
        body: "newer report msg",
        createdAt: new Date("2026-06-01T11:00:00.000Z"),
        senderId: OTHER,
      },
    }

    const svc = makeThreadsService({
      repo,
      readState: new InMemoryChatReadState(),
      report: reportSource([report]),
      now: () => NOW,
    })
    const { items } = await svc.listThreads(ME)
    expect(items.map((t) => t.kind)).toEqual(["report", "cleanup"])
    expect(items[0]!.title).toBe("Graffiti - Elm Ave")
    expect(items[1]!.title).toBe("Beach sweep")
  })
})

describe("threads service — real per-conversation muted on ALL families (DB-free)", () => {
  it("stamps muted per-family from the mutes source (cleanup + report muted, others not)", async () => {
    const repo = new InMemoryThreadsRepository()
    const c1 = repo.seedCleanup("Muted cleanup", CLEANUP_ID)
    repo.addMember(c1, ME, new Date("2026-06-01T08:00:00.000Z"))
    repo.addMessage(c1, {
      senderId: OTHER,
      body: "hi",
      createdAt: new Date("2026-06-01T10:00:00.000Z"),
    })

    const report: ReportThreadAggregateView = {
      reportId: REPORT_A,
      title: "Trash - Main",
      members: 1,
      unread: 0,
      joinedAt: new Date("2026-06-01T08:00:00.000Z"),
      last: {
        body: "report body",
        createdAt: new Date("2026-06-01T11:00:00.000Z"),
        senderId: OTHER,
      },
    }

    const { source, calls } = mutesSource([
      { roomKind: "cleanup", roomId: CLEANUP_ID },
      { roomKind: "report", roomId: REPORT_A },
    ])

    const svc = makeThreadsService({
      repo,
      readState: new InMemoryChatReadState(),
      report: reportSource([report]),
      mutes: source,
      now: () => NOW,
    })
    const { items } = await svc.listThreads(ME)
    const byKind = Object.fromEntries(items.map((t) => [t.kind, t]))
    expect(byKind.cleanup!.muted).toBe(true)
    expect(byKind.report!.muted).toBe(true)

    const kinds = calls.map((c) => c.roomKind).sort()
    expect(kinds).toEqual(["cleanup", "report"])
    expect(calls.find((c) => c.roomKind === "cleanup")!.roomIds).toEqual([CLEANUP_ID])
    expect(calls.find((c) => c.roomKind === "report")!.roomIds).toEqual([REPORT_A])
  })

  it("a muted cleanup (and only it) reports muted:true; an unmuted report stays false", async () => {
    const repo = new InMemoryThreadsRepository()
    const c1 = repo.seedCleanup("Cleanup", CLEANUP_ID)
    repo.addMember(c1, ME, new Date("2026-06-01T08:00:00.000Z"))
    repo.addMessage(c1, {
      senderId: OTHER,
      body: "hey",
      createdAt: new Date("2026-06-01T09:00:00.000Z"),
    })

    const report: ReportThreadAggregateView = {
      reportId: REPORT_A,
      title: "Recycling",
      members: 1,
      unread: 0,
      joinedAt: new Date("2026-06-01T08:00:00.000Z"),
      last: {
        body: "r",
        createdAt: new Date("2026-06-01T10:00:00.000Z"),
        senderId: OTHER,
      },
    }

    const { source } = mutesSource([{ roomKind: "cleanup", roomId: CLEANUP_ID }])
    const svc = makeThreadsService({
      repo,
      readState: new InMemoryChatReadState(),
      report: reportSource([report]),
      mutes: source,
      now: () => NOW,
    })
    const byKind = Object.fromEntries((await svc.listThreads(ME)).items.map((t) => [t.kind, t]))
    expect(byKind.cleanup!.muted).toBe(true)
    expect(byKind.report!.muted).toBe(false)
  })

  it("fails open: no mutes source wired -> every family's muted is false", async () => {
    const repo = new InMemoryThreadsRepository()
    const c1 = repo.seedCleanup("Cleanup", CLEANUP_ID)
    repo.addMember(c1, ME, new Date("2026-06-01T08:00:00.000Z"))
    repo.addMessage(c1, {
      senderId: OTHER,
      body: "x",
      createdAt: new Date("2026-06-01T09:00:00.000Z"),
    })
    const report: ReportThreadAggregateView = {
      reportId: REPORT_A,
      title: "Other",
      members: 1,
      unread: 0,
      joinedAt: new Date("2026-06-01T08:00:00.000Z"),
      last: { body: "y", createdAt: new Date("2026-06-01T10:00:00.000Z"), senderId: OTHER },
    }
    const svc = makeThreadsService({
      repo,
      readState: new InMemoryChatReadState(),
      report: reportSource([report]),
      now: () => NOW,
    })
    for (const t of (await svc.listThreads(ME)).items) {
      expect(t.muted).toBe(false)
    }
  })
})
