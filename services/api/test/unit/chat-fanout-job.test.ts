
import { describe, it, expect } from "vitest"
import { FakePushSender } from "@civfix/shared/fakes"
import type { ChatMessageDTO, PersonDTO } from "@civfix/shared"
import {
  CHAT_ROOM_FANOUT_JOB,
  makeRoomFanoutDispatcher,
  parseChatRoomFanoutJob,
  roomFanoutSingletonKey,
  runChatRoomFanout,
} from "../../src/services/chat-fanout-jobs.js"
import {
  makeRoomFanoutNotifier,
  runRoomFanout,
  ROOM_FANOUT_THROTTLE_MS,
  ROOM_FANOUT_SPEC,
  type RoomFanoutNotifierDeps,
} from "../../src/services/chat-room-fanout-notifier.js"
import { makeNotificationService } from "../../src/services/notification-service.js"
import { InMemoryNotificationRepository, flushNotificationDispatch } from "../helpers/notifications.js"

const ACTOR = "dddddddd-dddd-dddd-dddd-dddddddddddd"
const A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
const MUTED = "cccccccc-cccc-cccc-cccc-cccccccccccc"
const PRESENT = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee"
const ROOM = "11111111-1111-1111-1111-111111111111"

function person(id: string, name: string): PersonDTO {
  return { id, name, followers: 0, following: 0, isFollowing: false }
}

function message(id: string, body: string): ChatMessageDTO {
  return {
    id,
    cleanupId: ROOM,
    roomKind: "group",
    from: person(ACTOR, "Dana"),
    body,
    kind: "text",
    reactions: [],
    mentions: [],
    createdAt: new Date().toISOString(),
  }
}

class RecordingJobs {
  readonly sent: Array<{ name: string; data: unknown; singletonKey: string | undefined }> = []
  enqueue(name: string, data: unknown, opts?: { singletonKey?: string }): Promise<string> {
    this.sent.push({ name, data, singletonKey: opts?.singletonKey })
    return Promise.resolve(`job-${this.sent.length}`)
  }
}

function harness(overrides: Partial<RoomFanoutNotifierDeps> = {}) {
  const repo = new InMemoryNotificationRepository()
  const push = new FakePushSender()
  const listed: string[] = []
  const deps: RoomFanoutNotifierDeps = {
    notificationService: makeNotificationService({ repo, pushSender: push }),
    listMemberIds: (roomId) => {
      listed.push(roomId)
      return Promise.resolve([ACTOR, A, MUTED, PRESENT])
    },
    isMuted: (userId) => Promise.resolve(userId === MUTED),
    presence: { online: () => Promise.resolve([PRESENT]) },
    roomKey: (id) => `group:${id}`,
    isBlockedEitherWay: () => Promise.resolve(false),
    ...overrides,
  }
  return { repo, push, deps, listed }
}

function bells(repo: InMemoryNotificationRepository, userId: string) {
  return repo.notifications.filter((n) => n.userId === userId && n.type === "group_chat")
}

describe("chat.room.fanout job dispatch (H19)", () => {
  it("turns a 50-message burst into ONE enqueue and never scans the member list on the send path", async () => {
    const jobs = new RecordingJobs()
    let clockMs = 1_700_000_000_000
    const { repo, deps, listed } = harness()
    const notify = makeRoomFanoutNotifier(ROOM_FANOUT_SPEC.group, {
      ...deps,
      now: () => clockMs,
      dispatchToJob: makeRoomFanoutDispatcher(jobs, "group", { now: () => clockMs }),
    })

    for (let i = 0; i < 50; i++) {
      clockMs += 100
      await notify(ROOM, message(`m${i}`, `body ${i}`))
    }

    expect(jobs.sent).toHaveLength(1)
    expect(jobs.sent[0]!.name).toBe(CHAT_ROOM_FANOUT_JOB)
    expect(listed).toEqual([])
    expect(repo.notifications).toHaveLength(0)

    clockMs += ROOM_FANOUT_THROTTLE_MS + 1
    await notify(ROOM, message("m50", "body 50"))
    expect(jobs.sent).toHaveLength(2)
    expect(jobs.sent[1]!.singletonKey).not.toBe(jobs.sent[0]!.singletonKey)
  })

  it("queues IDS ONLY — no sender name, no message body reaches pgboss.job", async () => {
    const jobs = new RecordingJobs()
    const { deps } = harness()
    const notify = makeRoomFanoutNotifier(ROOM_FANOUT_SPEC.group, {
      ...deps,
      dispatchToJob: makeRoomFanoutDispatcher(jobs, "group"),
    })

    await notify(ROOM, message("msg-1", "secret message body"))

    expect(jobs.sent[0]!.data).toEqual({ kind: "group", roomId: ROOM, messageId: "msg-1" })
    expect(JSON.stringify(jobs.sent[0]!.data)).not.toContain("secret message body")
    expect(JSON.stringify(jobs.sent[0]!.data)).not.toContain("Dana")
  })

  it("buckets the singletonKey by room and window so concurrent processes collapse into one job", () => {
    const w = ROOM_FANOUT_THROTTLE_MS
    const base = 5 * w
    expect(roomFanoutSingletonKey("group", ROOM, base, w)).toBe(
      roomFanoutSingletonKey("group", ROOM, base + w - 1, w),
    )
    expect(roomFanoutSingletonKey("group", ROOM, base, w)).not.toBe(
      roomFanoutSingletonKey("group", ROOM, base + w, w),
    )
    expect(roomFanoutSingletonKey("group", ROOM, base, w)).not.toBe(
      roomFanoutSingletonKey("report", ROOM, base, w),
    )
    expect(roomFanoutSingletonKey("group", ROOM, base, w)).not.toBe(
      roomFanoutSingletonKey("group", "other-room", base, w),
    )
  })

  it("falls back to an INLINE fan-out when the queue is unavailable (bells are never dropped)", async () => {
    const { repo, deps } = harness()
    const warns: unknown[] = []
    const notify = makeRoomFanoutNotifier(ROOM_FANOUT_SPEC.group, {
      ...deps,
      logger: { warn: (obj: unknown) => warns.push(obj), error: () => {} },
      dispatchToJob: () => Promise.reject(new Error("pg-boss not started")),
    })

    await notify(ROOM, message("msg-1", "hello"))
    await flushNotificationDispatch()

    expect(bells(repo, A)).toHaveLength(1)
    expect(warns).toHaveLength(1)
  })

  it("does nothing when another process already claimed the room's window", async () => {
    const jobs = new RecordingJobs()
    const { repo, deps, listed } = harness()
    const notify = makeRoomFanoutNotifier(ROOM_FANOUT_SPEC.group, {
      ...deps,
      claimWindow: () => Promise.resolve(false),
      dispatchToJob: makeRoomFanoutDispatcher(jobs, "group"),
    })

    await notify(ROOM, message("msg-1", "hello"))

    expect(jobs.sent).toHaveLength(0)
    expect(listed).toEqual([])
    expect(repo.notifications).toHaveLength(0)
  })

  it("a claim failure fans out anyway rather than dropping the room's bells", async () => {
    const jobs = new RecordingJobs()
    const { deps } = harness()
    const notify = makeRoomFanoutNotifier(ROOM_FANOUT_SPEC.group, {
      ...deps,
      claimWindow: () => Promise.resolve(true),
      dispatchToJob: makeRoomFanoutDispatcher(jobs, "group"),
    })

    await notify(ROOM, message("msg-1", "hello"))
    expect(jobs.sent).toHaveLength(1)
  })
})

describe("chat.room.fanout job body", () => {
  it("runRoomFanout applies the sender, presence, mute and coalescing gates the live path applied", async () => {
    const { repo, push, deps } = harness()

    await runRoomFanout(ROOM_FANOUT_SPEC.group, deps, ROOM, message("msg-1", "hello"))
    await runRoomFanout(ROOM_FANOUT_SPEC.group, deps, ROOM, message("msg-2", "hello again"))
    await flushNotificationDispatch()

    expect(bells(repo, A)).toHaveLength(1)
    expect(bells(repo, A)[0]!.body).toContain("hello again")
    expect(bells(repo, ACTOR)).toHaveLength(0)
    expect(bells(repo, MUTED)).toHaveLength(0)
    expect(bells(repo, PRESENT)).toHaveLength(0)
    expect(push.sent.filter((p) => p.userId === A)).toHaveLength(1)
  })
})

describe("parseChatRoomFanoutJob", () => {
  it("accepts a well-formed payload and rejects everything else", () => {
    expect(parseChatRoomFanoutJob({ kind: "report", roomId: ROOM, messageId: "m" })).toEqual({
      kind: "report",
      roomId: ROOM,
      messageId: "m",
    })
    expect(parseChatRoomFanoutJob(null)).toBeNull()
    expect(parseChatRoomFanoutJob("nope")).toBeNull()
    expect(parseChatRoomFanoutJob({ kind: "cleanup", roomId: ROOM, messageId: "m" })).toBeNull()
    expect(parseChatRoomFanoutJob({ kind: "group", roomId: "", messageId: "m" })).toBeNull()
    expect(parseChatRoomFanoutJob({ kind: "group", roomId: ROOM })).toBeNull()
  })
})

describe("chat.room.fanout tombstone gate", () => {
  function runDeps(deps: RoomFanoutNotifierDeps, message: ChatMessageDTO | null) {
    return {
      loadMessage: () => Promise.resolve(message),
      fanoutDeps: { group: deps, report: deps },
    }
  }

  it("does NOT bell members for a message deleted between the enqueue and the run", async () => {
    const { repo, deps, listed } = harness()
    const tombstoned: ChatMessageDTO = {
      ...message("msg-1", "removed by an operator"),
      body: null,
      deletedAt: new Date().toISOString(),
    }

    await runChatRoomFanout(runDeps(deps, tombstoned), {
      kind: "group",
      roomId: ROOM,
      messageId: "msg-1",
    })
    await flushNotificationDispatch()

    expect(repo.notifications).toHaveLength(0)
    expect(listed).toEqual([])
  })

  it("does nothing when the message is gone entirely", async () => {
    const { repo, deps } = harness()
    await runChatRoomFanout(runDeps(deps, null), {
      kind: "group",
      roomId: ROOM,
      messageId: "msg-1",
    })
    await flushNotificationDispatch()
    expect(repo.notifications).toHaveLength(0)
  })

  it("bells members for the same message while it is NOT deleted (the gate is the tombstone)", async () => {
    const { repo, deps } = harness()
    await runChatRoomFanout(runDeps(deps, message("msg-1", "still here")), {
      kind: "group",
      roomId: ROOM,
      messageId: "msg-1",
    })
    await flushNotificationDispatch()
    expect(bells(repo, A)).toHaveLength(1)
  })
})
