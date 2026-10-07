import { describe, it, expect, vi } from "vitest"
import { FakePushSender } from "@civfix/shared/fakes"
import type { ChatMessageDTO } from "@civfix/shared"
import { runChatRoomFanout } from "../../src/services/chat-fanout-jobs.js"
import {
  makeRoomFanoutNotifier,
  runRoomFanout,
  ROOM_FANOUT_SPEC,
  type RoomFanoutNotifierDeps,
} from "../../src/services/chat-room-fanout-notifier.js"
import { makeNotificationService } from "../../src/services/notification-service.js"
import { InMemoryNotificationRepository } from "../helpers/notifications.js"

const ACTOR = "dddddddd-dddd-dddd-dddd-dddddddddddd"
const A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
const B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
const C = "cccccccc-cccc-cccc-cccc-cccccccccccc"
const ROOM = "11111111-1111-1111-1111-111111111111"
const BODY = "meet at the north gate"

function message(): ChatMessageDTO {
  return {
    id: "m-1",
    cleanupId: ROOM,
    roomKind: "group",
    from: { id: ACTOR, name: "Dana", followers: 0, following: 0, isFollowing: false },
    body: BODY,
    kind: "text",
    reactions: [],
    mentions: [],
    createdAt: new Date().toISOString(),
  }
}

function failingFor(repo: InMemoryNotificationRepository, broken: Set<string>): void {
  const insert = repo.insertNotification.bind(repo)
  const upsert = repo.upsertCoalescedNotification.bind(repo)
  repo.insertNotification = (args) =>
    broken.has(args.userId)
      ? Promise.reject(new Error("notifications table unavailable"))
      : insert(args)
  repo.upsertCoalescedNotification = (args) =>
    broken.has(args.userId)
      ? Promise.reject(new Error("notifications table unavailable"))
      : upsert(args)
}

function logger() {
  return { warn: vi.fn(), error: vi.fn() }
}

function harness(opts: { broken?: string[]; members?: string[] } = {}) {
  const repo = new InMemoryNotificationRepository()
  const broken = new Set(opts.broken ?? [])
  failingFor(repo, broken)
  const serviceLog = logger()
  const fanoutLog = logger()
  const deps: RoomFanoutNotifierDeps = {
    notificationService: makeNotificationService({
      repo,
      pushSender: new FakePushSender(),
      logger: serviceLog,
    }),
    listMemberIds: () => Promise.resolve([ACTOR, ...(opts.members ?? [A, B])]),
    isMuted: () => Promise.resolve(false),
    roomKey: (id) => `group:${id}`,
    isBlockedEitherWay: () => Promise.resolve(false),
    logger: fanoutLog,
  }
  return { repo, broken, deps, serviceLog, fanoutLog }
}

function bells(repo: InMemoryNotificationRepository, userId: string) {
  return repo.notifications.filter((n) => n.userId === userId && n.type === "group_chat")
}

function runJob(deps: RoomFanoutNotifierDeps): Promise<void> {
  return runChatRoomFanout(
    {
      loadMessage: () => Promise.resolve(message()),
      fanoutDeps: { group: deps, report: deps },
    },
    { kind: "group", roomId: ROOM, messageId: "m-1" },
  )
}

describe("room fan-out bell write failures, through the real notification service", () => {
  it("fail the chat.room.fanout job when no bell could be written, so pg-boss retries it", async () => {
    const h = harness({ broken: [A, B] })

    await expect(runJob(h.deps)).rejects.toThrow(/no bell/)
    expect(h.repo.notifications).toHaveLength(0)
  })

  it("let a retry after a total failure write each bell exactly once", async () => {
    const h = harness({ broken: [A, B] })
    await expect(runJob(h.deps)).rejects.toThrow()

    h.broken.clear()
    await runJob(h.deps)

    expect(bells(h.repo, A)).toHaveLength(1)
    expect(bells(h.repo, B)).toHaveLength(1)
  })

  it("never double-bell a recipient whose bell landed when the same fan-out runs again", async () => {
    const h = harness({ broken: [B] })
    await runJob(h.deps)

    h.broken.clear()
    await runJob(h.deps)

    expect(bells(h.repo, A)).toHaveLength(1)
    expect(bells(h.repo, B)).toHaveLength(1)
  })

  it("complete a partial failure with one summary line that carries counts and no message text", async () => {
    const h = harness({ broken: [B], members: [A, B, C] })

    await expect(runJob(h.deps)).resolves.toBeUndefined()

    expect(bells(h.repo, A)).toHaveLength(1)
    expect(bells(h.repo, C)).toHaveLength(1)
    const summaries = h.fanoutLog.warn.mock.calls.filter(([, msg]) =>
      /bells were not written/.test(String(msg)),
    )
    expect(summaries).toHaveLength(1)
    expect(summaries[0]?.[0]).toEqual({ kind: "group", recipients: 3, failed: 1 })
    expect(JSON.stringify(h.fanoutLog.warn.mock.calls)).not.toContain(BODY)
  })

  it("log one line for a whole outage from the notification service, not one per recipient", async () => {
    const members = Array.from(
      { length: 20 },
      (_, i) => `aaaaaaaa-aaaa-aaaa-aaaa-${String(i).padStart(12, "0")}`,
    )
    const h = harness({ broken: members, members })

    await expect(runJob(h.deps)).rejects.toThrow()

    expect(h.serviceLog.warn.mock.calls.length).toBeLessThanOrEqual(2)
    expect(JSON.stringify(h.serviceLog.warn.mock.calls)).not.toContain(BODY)
  })

  it("are logged on the inline path, which stays best-effort for the sender", async () => {
    const h = harness({ broken: [A, B] })
    const notify = makeRoomFanoutNotifier(ROOM_FANOUT_SPEC.group, h.deps)

    await expect(notify(ROOM, message())).resolves.toBeUndefined()

    expect(h.fanoutLog.error).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "group" }),
      expect.stringMatching(/fan-out failed/),
    )
  })
})

describe("room fan-out lookup fallbacks", () => {
  it("log a failed mute or block batch lookup before falling back", async () => {
    const h = harness()
    const notify = makeRoomFanoutNotifier(ROOM_FANOUT_SPEC.group, {
      ...h.deps,
      mutedUserIdsFor: () => Promise.reject(new Error("mutes down")),
      blockedIdsFor: () => Promise.resolve(new Set<string>()),
    })

    await notify(ROOM, message())

    expect(h.fanoutLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "group" }),
      expect.stringMatching(/mute lookup failed/),
    )
  })

  it("summarize per-recipient mute lookup failures in one line and still notify everyone", async () => {
    const h = harness({ members: [A, B, C] })

    await runRoomFanout(
      ROOM_FANOUT_SPEC.group,
      {
        ...h.deps,
        isMuted: () => Promise.reject(new Error("mutes down")),
      },
      ROOM,
      message(),
    )

    const lines = h.fanoutLog.warn.mock.calls.filter(([, msg]) => /mute lookup/.test(String(msg)))
    expect(lines).toHaveLength(1)
    expect(lines[0]?.[0]).toMatchObject({ kind: "group", failed: 3, candidates: 3 })
    expect(bells(h.repo, A)).toHaveLength(1)
    expect(bells(h.repo, C)).toHaveLength(1)
  })

  it("summarize per-recipient block lookup failures in one line and skip those recipients", async () => {
    const h = harness({ members: [A, B, C] })

    await runRoomFanout(
      ROOM_FANOUT_SPEC.group,
      {
        ...h.deps,
        isBlockedEitherWay: (_actor, id) =>
          id === C ? Promise.resolve(false) : Promise.reject(new Error("blocks down")),
      },
      ROOM,
      message(),
    )

    const lines = h.fanoutLog.warn.mock.calls.filter(([, msg]) => /block lookup/.test(String(msg)))
    expect(lines).toHaveLength(1)
    expect(lines[0]?.[0]).toMatchObject({ kind: "group", failed: 2, candidates: 3 })
    expect(bells(h.repo, A)).toHaveLength(0)
    expect(bells(h.repo, C)).toHaveLength(1)
  })
})
