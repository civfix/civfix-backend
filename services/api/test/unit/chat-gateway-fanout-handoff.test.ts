import { describe, it, expect, beforeEach } from "vitest"
import type { ChatMessageDTO } from "@civfix/shared"
import {
  handleClientFrame,
  type GatewayDeps,
  type GatewayGroupChat,
  type GatewaySession,
} from "../../src/ws/gateway.js"
import { WsChatService } from "../../src/adapters/chat-service.ws.js"
import { InMemoryChatPubSub } from "../../src/adapters/chat-pubsub.js"
import { InMemoryChatRepository, MockConnection } from "../helpers/chat.js"
import { makeGroupChatNotifier } from "../../src/services/group-chat-notifier.js"
import { makeReportChatNotifier } from "../../src/services/report-chat-notifier.js"
import {
  CHAT_ROOM_FANOUT_JOB,
  makeRoomFanoutDispatcher,
  roomFanoutSingletonKey,
} from "../../src/services/chat-fanout-jobs.js"
import { ROOM_FANOUT_THROTTLE_MS } from "../../src/services/chat-room-fanout-notifier.js"
import { roomKeyFor } from "../../src/ws/gateway.js"
import { roomFanoutMode } from "../../src/routes/chat-gateway-wiring.js"

const GROUP = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
const REPORT = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
const ALICE = "11111111-1111-1111-1111-111111111111"

class RecordingJobs {
  readonly sent: Array<{ name: string; data: unknown; singletonKey: string | undefined }> = []
  enqueue(name: string, data: unknown, opts?: { singletonKey?: string }): Promise<string> {
    this.sent.push({ name, data, singletonKey: opts?.singletonKey })
    return Promise.resolve(`job-${this.sent.length}`)
  }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

let repo: InMemoryChatRepository
let chat: WsChatService

const groupChat: GatewayGroupChat = {
  isMember: () => Promise.resolve(true),
  access: () => Promise.resolve({ isMember: true, canPost: true, visibility: "private" as const }),
  advanceReadWatermark: () => Promise.resolve(),
}

interface FanoutProbe {
  jobs: RecordingJobs
  listed: string[]
  notified: string[][]
}

function probe(): FanoutProbe {
  return { jobs: new RecordingJobs(), listed: [], notified: [] }
}

function notifierDeps(p: FanoutProbe) {
  return {
    notificationService: {
      createNotifications: (recipients: string[]) => {
        p.notified.push(recipients)
        return Promise.resolve()
      },
    },
    isMuted: () => Promise.resolve(false),
    presence: { online: () => Promise.resolve([] as string[]) },
    roomKeyFor,
    isBlockedEitherWay: () => Promise.resolve(false),
  }
}

function session(deps: Partial<GatewayDeps>, conn: MockConnection): GatewaySession {
  const full: GatewayDeps = {
    chat,
    isMember: () => Promise.resolve(true),
    groupChat,
    ...deps,
  }
  return {
    userId: ALICE,
    conn,
    joined: new Set<string>(),
    typingThrottle: new Map<string, number>(),
    deps: full,
  }
}

beforeEach(() => {
  repo = new InMemoryChatRepository()
  repo.registerSender({ id: ALICE, displayName: "Alice", handle: "alice" })
  chat = new WsChatService({ repo, pubsub: new InMemoryChatPubSub() })
})

describe("H19 over the WS send lane: a burst enqueues one job, never fans out inline", () => {
  it("group room: 20 sends -> ONE chat.room.fanout enqueue, member list never scanned", async () => {
    const p = probe()
    const notify = makeGroupChatNotifier({
      ...notifierDeps(p),
      groupRepo: {
        listMemberIds: (groupId: string) => {
          p.listed.push(groupId)
          return Promise.resolve([])
        },
      },
      dispatchToJob: makeRoomFanoutDispatcher(p.jobs, "group"),
    })
    const conn = new MockConnection("A")
    const s = session(
      { onGroupMessage: (groupId, message) => notify(groupId, message) },
      conn,
    )
    await handleClientFrame(
      s,
      JSON.stringify({ type: "join", cleanupId: GROUP, roomKind: "group" }),
    )

    for (let i = 0; i < 20; i++) {
      await handleClientFrame(
        s,
        JSON.stringify({
          type: "send",
          cleanupId: GROUP,
          roomKind: "group",
          body: `burst ${i}`,
          clientId: `c${i}`,
        }),
      )
    }
    await flush()

    expect(conn.framesOfType("ack")).toHaveLength(20)
    expect(p.jobs.sent).toHaveLength(1)
    expect(p.jobs.sent[0]!.name).toBe(CHAT_ROOM_FANOUT_JOB)
    expect(p.listed).toEqual([])
    expect(p.notified).toEqual([])
  })

  it("the enqueued job carries ids only — no body, no sender name reaches pgboss.job", async () => {
    const p = probe()
    const notify = makeGroupChatNotifier({
      ...notifierDeps(p),
      groupRepo: { listMemberIds: () => Promise.resolve([]) },
      dispatchToJob: makeRoomFanoutDispatcher(p.jobs, "group"),
    })
    const conn = new MockConnection("A")
    const s = session({ onGroupMessage: (groupId, m) => notify(groupId, m) }, conn)
    await handleClientFrame(
      s,
      JSON.stringify({ type: "join", cleanupId: GROUP, roomKind: "group" }),
    )
    await handleClientFrame(
      s,
      JSON.stringify({
        type: "send",
        cleanupId: GROUP,
        roomKind: "group",
        body: "my home address is 123 Fake St",
        clientId: "c1",
      }),
    )
    await flush()

    const ack = conn.framesOfType("ack").at(-1) as { message: ChatMessageDTO }
    expect(p.jobs.sent[0]!.data).toEqual({
      kind: "group",
      roomId: GROUP,
      messageId: ack.message.id,
    })
    const serialized = JSON.stringify(p.jobs.sent[0])
    expect(serialized).not.toContain("home address")
    expect(serialized).not.toContain("Alice")
  })

  it("the singletonKey buckets by room + window so concurrent workers collapse to one job", async () => {
    const p = probe()
    const at = 1_700_000_000_000
    const notify = makeGroupChatNotifier({
      ...notifierDeps(p),
      groupRepo: { listMemberIds: () => Promise.resolve([]) },
      dispatchToJob: makeRoomFanoutDispatcher(p.jobs, "group", { now: () => at }),
    })
    const conn = new MockConnection("A")
    const s = session({ onGroupMessage: (groupId, m) => notify(groupId, m) }, conn)
    await handleClientFrame(
      s,
      JSON.stringify({ type: "join", cleanupId: GROUP, roomKind: "group" }),
    )
    await handleClientFrame(
      s,
      JSON.stringify({ type: "send", cleanupId: GROUP, roomKind: "group", body: "x", clientId: "c1" }),
    )
    await flush()

    expect(p.jobs.sent[0]!.singletonKey).toBe(
      roomFanoutSingletonKey("group", GROUP, at, ROOM_FANOUT_THROTTLE_MS),
    )
  })

  it("report room: the send lane hands off the same way", async () => {
    const p = probe()
    const notify = makeReportChatNotifier({
      ...notifierDeps(p),
      reportChatRepo: {
        listMemberIds: (reportId: string) => {
          p.listed.push(reportId)
          return Promise.resolve([])
        },
      },
      dispatchToJob: makeRoomFanoutDispatcher(p.jobs, "report"),
    })
    const conn = new MockConnection("A")
    const s = session(
      {
        reportChat: { isMember: () => Promise.resolve(true), advanceReadWatermark: () => Promise.resolve() },
        onReportMessage: (reportId, message) => notify(reportId, message),
      },
      conn,
    )
    await handleClientFrame(
      s,
      JSON.stringify({ type: "join", cleanupId: REPORT, roomKind: "report" }),
    )
    for (let i = 0; i < 5; i++) {
      await handleClientFrame(
        s,
        JSON.stringify({
          type: "send",
          cleanupId: REPORT,
          roomKind: "report",
          body: `r${i}`,
          clientId: `r${i}`,
        }),
      )
    }
    await flush()

    expect(p.jobs.sent).toHaveLength(1)
    expect(p.jobs.sent[0]!.data).toMatchObject({ kind: "report", roomId: REPORT })
    expect(p.listed).toEqual([])
    expect(p.notified).toEqual([])
  })

  it("USE_FAKE_JOBS never queues: FakeJobs registers no chat.room.fanout handler, so bells must stay inline", () => {
    expect(roomFanoutMode({ useFakeChat: false, useFakeJobs: false, usesRealRedis: true })).toEqual({
      queued: true,
      claimed: true,
    })
    expect(roomFanoutMode({ useFakeChat: false, useFakeJobs: true, usesRealRedis: true })).toEqual({
      queued: false,
      claimed: true,
    })
    expect(roomFanoutMode({ useFakeChat: true, useFakeJobs: false, usesRealRedis: true })).toEqual({
      queued: false,
      claimed: false,
    })
    expect(roomFanoutMode({ useFakeChat: false, useFakeJobs: false, usesRealRedis: false })).toEqual({
      queued: false,
      claimed: false,
    })
  })

  it("fake jobs + real Redis: the send still fans out inline and the bells fire", async () => {
    const p = probe()
    const claimed: Array<[string, number]> = []
    const notify = makeGroupChatNotifier({
      ...notifierDeps(p),
      groupRepo: {
        listMemberIds: (groupId: string) => {
          p.listed.push(groupId)
          return Promise.resolve(["member-1", "member-2"])
        },
      },
      claimWindow: (roomId, windowMs) => {
        claimed.push([roomId, windowMs])
        return Promise.resolve(true)
      },
    })
    const conn = new MockConnection("A")
    const s = session({ onGroupMessage: (groupId, m) => notify(groupId, m) }, conn)
    await handleClientFrame(
      s,
      JSON.stringify({ type: "join", cleanupId: GROUP, roomKind: "group" }),
    )
    await handleClientFrame(
      s,
      JSON.stringify({ type: "send", cleanupId: GROUP, roomKind: "group", body: "x", clientId: "c1" }),
    )
    await flush()

    expect(p.jobs.sent).toEqual([])
    expect(claimed).toEqual([[GROUP, ROOM_FANOUT_THROTTLE_MS]])
    expect(p.listed).toEqual([GROUP])
    expect(p.notified).toEqual([["member-1", "member-2"]])
  })

  it("an enqueue failure falls back to fanning out inline (the queue is not a hard dependency)", async () => {
    const p = probe()
    const notify = makeGroupChatNotifier({
      ...notifierDeps(p),
      groupRepo: {
        listMemberIds: (groupId: string) => {
          p.listed.push(groupId)
          return Promise.resolve([])
        },
      },
      dispatchToJob: () => Promise.reject(new Error("pg-boss not started")),
    })
    const conn = new MockConnection("A")
    const s = session({ onGroupMessage: (groupId, m) => notify(groupId, m) }, conn)
    await handleClientFrame(
      s,
      JSON.stringify({ type: "join", cleanupId: GROUP, roomKind: "group" }),
    )
    await handleClientFrame(
      s,
      JSON.stringify({ type: "send", cleanupId: GROUP, roomKind: "group", body: "x", clientId: "c1" }),
    )
    await flush()

    expect(conn.framesOfType("ack")).toHaveLength(1)
    expect(conn.framesOfType("error")).toEqual([])
    expect(p.listed).toEqual([GROUP])
  })
})
