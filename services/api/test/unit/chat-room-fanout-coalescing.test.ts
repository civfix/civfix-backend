import { describe, it, expect, beforeEach } from "vitest"
import { FakePushSender } from "@civfix/shared/fakes"
import type { ChatMessageDTO, PersonDTO, UserMentionDTO } from "@civfix/shared"
import type { PushPayload, PushSender } from "@civfix/shared/interfaces"
import {
  makeRoomFanoutNotifier,
  ROOM_ACTIVITY_COALESCE_WINDOW_MS,
  ROOM_FANOUT_THROTTLE_MS,
} from "../../src/services/chat-room-fanout-notifier.js"
import {
  makeNotificationService,
  type NotificationService,
} from "../../src/services/notification-service.js"
import {
  InMemoryNotificationRepository,
  flushNotificationDispatch,
} from "../helpers/notifications.js"

const ACTOR = "dddddddd-dddd-dddd-dddd-dddddddddddd"
const A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
const B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
const MUTED = "cccccccc-cccc-cccc-cccc-cccccccccccc"
const MENTIONED = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee"
const ROOM = "11111111-1111-1111-1111-111111111111"

function person(id: string, name: string): PersonDTO {
  return { id, name, followers: 0, following: 0, isFollowing: false }
}

function message(body: string, mentions: UserMentionDTO[] = []): ChatMessageDTO {
  return {
    id: `msg-${body}`,
    cleanupId: ROOM,
    roomKind: "group",
    from: person(ACTOR, "Dana"),
    body,
    kind: "text",
    reactions: [],
    mentions,
    createdAt: new Date().toISOString(),
  }
}

function anonymousMessage(): ChatMessageDTO {
  return {
    id: "sys-1",
    cleanupId: ROOM,
    roomKind: "group",
    from: null,
    body: null,
    kind: "system",
    reactions: [],
    mentions: [],
    createdAt: new Date().toISOString(),
  }
}

let repo: InMemoryNotificationRepository
let push: FakePushSender
let notifications: NotificationService
let clockMs: number

beforeEach(() => {
  clockMs = 1_700_000_000_000
  repo = new InMemoryNotificationRepository()
  repo.now = () => new Date(clockMs)
  push = new FakePushSender()
  notifications = makeNotificationService({
    repo,
    pushSender: push,
    now: () => new Date(clockMs),
  })
})

function makeNotifier(opts: { muted?: Set<string>; members: string[] }) {
  const muted = opts.muted ?? new Set<string>()
  return makeRoomFanoutNotifier(
    { kind: "group", titleFallbackKey: "notification.group_chat.title_fallback" },
    {
      notificationService: notifications,
      listMemberIds: () => Promise.resolve(opts.members),
      isMuted: (userId) => Promise.resolve(muted.has(userId)),
      roomKey: (id) => `group:${id}`,
      isBlockedEitherWay: () => Promise.resolve(false),
      now: () => clockMs,
    },
  )
}

function bells(userId: string) {
  return repo.notifications.filter((n) => n.userId === userId && n.type === "group_chat")
}

describe("room-activity coalescing (H19)", () => {
  it("collapses a 50-message burst into ONE unread bell and ONE push per recipient", async () => {
    const notify = makeNotifier({ members: [ACTOR, A, B, MUTED], muted: new Set([MUTED]) })

    for (let i = 0; i < 50; i++) {
      clockMs += 1_000
      await notify(ROOM, message(`m${i}`))
    }
    await flushNotificationDispatch()

    expect(bells(A)).toHaveLength(1)
    expect(bells(B)).toHaveLength(1)
    expect(bells(A)[0]!.readAt).toBeNull()
    expect(push.sent.filter((p) => p.userId === A)).toHaveLength(1)
    expect(push.sent.filter((p) => p.userId === B)).toHaveLength(1)

    expect(bells(ACTOR)).toHaveLength(0)
    expect(bells(MUTED)).toHaveLength(0)
    expect(push.sent.some((p) => p.userId === MUTED || p.userId === ACTOR)).toBe(false)
  })

  it("rings again once the window has passed", async () => {
    const notify = makeNotifier({ members: [ACTOR, A] })

    await notify(ROOM, message("first"))
    clockMs += ROOM_ACTIVITY_COALESCE_WINDOW_MS + 1
    await notify(ROOM, message("later"))
    await flushNotificationDispatch()

    expect(bells(A)).toHaveLength(2)
    expect(push.sent.filter((p) => p.userId === A)).toHaveLength(2)
  })

  it("coalesces per ROOM, not globally: a second room still rings inside the same window", async () => {
    const other = "22222222-2222-2222-2222-222222222222"
    const notify = makeNotifier({ members: [ACTOR, A] })

    await notify(ROOM, message("here"))
    clockMs += 1_000
    await notify(other, message("there"))
    await flushNotificationDispatch()

    expect(bells(A)).toHaveLength(2)
    expect(
      bells(A)
        .map((n) => n.link)
        .sort(),
    ).toEqual([`/messages/group/${ROOM}`, `/messages/group/${other}`].sort())
  })

  it("refreshes the coalesced bell to the LATEST sender + preview instead of inserting a second row", async () => {
    const notify = makeNotifier({ members: [ACTOR, A] })
    await notify(ROOM, message("first message"))

    clockMs += ROOM_FANOUT_THROTTLE_MS + 1
    await notify(ROOM, message("second message"))
    await flushNotificationDispatch()

    expect(bells(A)).toHaveLength(1)
    expect(bells(A)[0]!.body).toContain("second message")
    expect(push.sent.filter((p) => p.userId === A)).toHaveLength(1)
  })

  it("re-rings on the SAME instance after the recipient reads (opens) the room, inside the bell window", async () => {
    const started = clockMs
    const notify = makeNotifier({ members: [ACTOR, A] })
    await notify(ROOM, message("first"))

    await notifications.clearByTypeAndLink(A, "group_chat", `/messages/group/${ROOM}`)
    expect(bells(A)[0]!.readAt).not.toBeNull()

    clockMs += ROOM_FANOUT_THROTTLE_MS + 1
    expect(clockMs - started).toBeLessThan(ROOM_ACTIVITY_COALESCE_WINDOW_MS)
    await notify(ROOM, message("after open"))
    await flushNotificationDispatch()

    const unread = bells(A).filter((n) => n.readAt === null)
    expect(unread).toHaveLength(1)
    expect(push.sent.filter((p) => p.userId === A)).toHaveLength(2)
  })

  it("leaves the mention bell alone: mentioned members are excluded and their own bells are per message", async () => {
    const notify = makeNotifier({ members: [ACTOR, A, MENTIONED] })
    const mention: UserMentionDTO[] = [
      { id: MENTIONED, handle: "mentioned", displayName: "Mentioned" },
    ]

    await notify(ROOM, message("hey @mentioned", mention))
    clockMs += 1_000
    await notify(ROOM, message("again @mentioned", mention))
    await flushNotificationDispatch()

    expect(bells(MENTIONED)).toHaveLength(0)

    for (const body of ["hey", "again"]) {
      await notifications.createNotification(MENTIONED, {
        type: "post_mention",
        title: "Dana",
        body,
        link: `/messages/group/${ROOM}`,
      })
    }
    await flushNotificationDispatch()
    expect(repo.notifications.filter((n) => n.userId === MENTIONED)).toHaveLength(2)
    expect(push.sent.filter((p) => p.userId === MENTIONED)).toHaveLength(2)
  })

  it("does not wait on the push provider: a hanging sender never blocks the fan-out", async () => {
    const hanging: PushSender = {
      registerToken: () => Promise.resolve(),
      send: (): Promise<void> => new Promise(() => {}),
      sendMany: (_userIds: string[], _payload: PushPayload): Promise<void> => new Promise(() => {}),
    }
    const service = makeNotificationService({
      repo,
      pushSender: hanging,
      now: () => new Date(clockMs),
    })
    const notify = makeRoomFanoutNotifier(
      { kind: "group", titleFallbackKey: "notification.group_chat.title_fallback" },
      {
        notificationService: service,
        listMemberIds: () => Promise.resolve([ACTOR, A]),
        isMuted: () => Promise.resolve(false),
        roomKey: (id) => `group:${id}`,
        isBlockedEitherWay: () => Promise.resolve(false),
        now: () => clockMs,
      },
    )

    await expect(notify(ROOM, message("hi"))).resolves.toBeUndefined()
    await expect(
      service.createNotification(B, { type: "system", title: "Heads up", link: "/x" }),
    ).resolves.toMatchObject({ type: "system" })
    expect(bells(A)).toHaveLength(1)
  })
})

describe("fan-out cost per recipient (R3b)", () => {
  it("resolves every recipient's locale in ONE batched query, not one point read per member", async () => {
    const members = Array.from(
      { length: 200 },
      (_, i) => `00000000-0000-4000-a000-${String(i).padStart(12, "0")}`,
    )
    for (const id of members) repo.locales.set(id, "es")

    const notify = makeRoomFanoutNotifier(
      { kind: "group", titleFallbackKey: "notification.group_chat.title_fallback" },
      {
        notificationService: notifications,
        listMemberIds: () => Promise.resolve(members),
        isMuted: () => Promise.resolve(false),
        roomKey: (id) => `group:${id}`,
        isBlockedEitherWay: () => Promise.resolve(false),
        now: () => clockMs,
      },
    )

    await notify(ROOM, anonymousMessage())
    await flushNotificationDispatch()

    expect(repo.localeBatchCalls).toEqual([members.length])
    expect(repo.localeCalls).toEqual([])
    expect(repo.notifications.filter((n) => n.type === "group_chat")).toHaveLength(members.length)
  })

  it("skips the locale query entirely when the copy carries no message keys", async () => {
    const notify = makeNotifier({ members: [ACTOR, A] })
    await notify(ROOM, message("plain preview"))
    await flushNotificationDispatch()

    expect(repo.localeBatchCalls).toEqual([])
    expect(repo.localeCalls).toEqual([])
  })
})
