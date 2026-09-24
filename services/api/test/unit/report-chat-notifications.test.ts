import { describe, it, expect, beforeEach } from "vitest"
import { FakePushSender } from "@civfix/shared/fakes"
import type { ChatMessageDTO, PersonDTO, ReplyToDTO, UserMentionDTO } from "@civfix/shared"
import {
  makeReportChatNotifier,
  REPORT_CHAT_FANOUT_MEMBER_CAP,
} from "../../src/services/report-chat-notifier.js"
import {
  makeRoomFanoutNotifier,
  ROOM_FANOUT_MEMBER_CAP,
} from "../../src/services/chat-room-fanout-notifier.js"
import { makeDmBellNotifier } from "../../src/services/chat-bells.js"
import {
  InMemoryNotificationRepository,
  flushNotificationDispatch,
} from "../helpers/notifications.js"
import type { NotificationPrefsRecord } from "../../src/services/notification-repository.js"
import {
  makeNotificationService,
  PUSH_FANOUT_BATCH_SIZE,
  type NotificationService,
} from "../../src/services/notification-service.js"
import type { PushSender } from "@civfix/shared/interfaces"
import type { ConversationMutesRepository } from "../../src/services/conversation-mutes-repository.js"
import type { ConversationMuteRoomKind } from "../../src/db/schema/conversation_mutes.js"

class InMemoryConversationMutes implements ConversationMutesRepository {
  private readonly muted = new Set<string>()
  readonly isMutedCalls: string[] = []
  protected key(u: string, k: ConversationMuteRoomKind, r: string): string {
    return `${u}|${k}|${r}`
  }
  protected has(u: string, k: ConversationMuteRoomKind, r: string): boolean {
    return this.muted.has(this.key(u, k, r))
  }
  mute(userId: string, roomKind: ConversationMuteRoomKind, roomId: string): void {
    this.muted.add(this.key(userId, roomKind, roomId))
  }
  isMuted(userId: string, roomKind: ConversationMuteRoomKind, roomId: string): Promise<boolean> {
    this.isMutedCalls.push(this.key(userId, roomKind, roomId))
    return Promise.resolve(this.has(userId, roomKind, roomId))
  }
  setMuted(): Promise<void> {
    return Promise.resolve()
  }
  mutedRoomIdsFor(): Promise<Set<string>> {
    return Promise.resolve(new Set())
  }
}

class InMemoryConversationMutesBatch extends InMemoryConversationMutes {
  readonly batchCalls: Array<{ roomKind: ConversationMuteRoomKind; roomId: string }> = []
  mutedUserIdsFor(
    roomKind: ConversationMuteRoomKind,
    roomId: string,
    userIds: string[],
  ): Promise<Set<string>> {
    this.batchCalls.push({ roomKind, roomId })
    return Promise.resolve(new Set(userIds.filter((u) => this.has(u, roomKind, roomId))))
  }
}

const A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
const B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
const C = "cccccccc-cccc-cccc-cccc-cccccccccccc"
const ACTOR = "dddddddd-dddd-dddd-dddd-dddddddddddd"
const REPORT = "11111111-1111-1111-1111-111111111111"

function person(id: string, name: string): PersonDTO {
  return { id, name, followers: 0, following: 0, isFollowing: false }
}

function userMessage(
  fromId: string,
  name: string,
  body: string,
  opts?: { replyTo?: ReplyToDTO; mentions?: UserMentionDTO[] },
): ChatMessageDTO {
  return {
    id: "msg-1",
    cleanupId: REPORT,
    roomKind: "report",
    from: person(fromId, name),
    body,
    kind: "text",
    reactions: [],
    mentions: opts?.mentions ?? [],
    createdAt: new Date().toISOString(),
    ...(opts?.replyTo ? { replyToId: opts.replyTo.id, replyTo: opts.replyTo } : {}),
  }
}

function replyPreviewFrom(senderId: string, senderName: string): ReplyToDTO {
  return {
    id: "target-1",
    from: { id: senderId, displayName: senderName },
    excerpt: "orig",
    kind: "text",
  }
}

function systemMessage(): ChatMessageDTO {
  return {
    id: "sys-1",
    cleanupId: REPORT,
    roomKind: "report",
    from: null,
    body: "Status changed to in_progress",
    kind: "system",
    reactions: [],
    mentions: [],
    createdAt: new Date().toISOString(),
    system: { status: "in_progress" },
  }
}

let notifRepo: InMemoryNotificationRepository
let push: FakePushSender
let notifications: NotificationService

const roomKeyFor = (kind: "report", id: string): string => `${kind}:${id}`

function reportNotifs(userId: string): typeof notifRepo.notifications {
  return notifRepo.notifications.filter((n) => n.userId === userId && n.type === "report_chat")
}

beforeEach(() => {
  notifRepo = new InMemoryNotificationRepository()
  push = new FakePushSender()
  notifications = makeNotificationService({ repo: notifRepo, pushSender: push })
})

describe("makeReportChatNotifier (D-E2)", () => {
  it("notifies only members who are not the actor, not present, and not muted; user message uses sender name + report link", async () => {
    const members = [A, B, C, ACTOR]
    const present = new Set([B])
    const muted = new Set([C])

    const notify = makeReportChatNotifier({
      notificationService: notifications,
      reportChatRepo: { listMemberIds: () => Promise.resolve(members) },
      isMuted: (userId) => Promise.resolve(muted.has(userId)),
      presence: { online: () => Promise.resolve([...present]) },
      roomKeyFor,
      isBlockedEitherWay: () => Promise.resolve(false),
    })

    await notify(REPORT, userMessage(ACTOR, "Dana", "hello everyone"))

    expect(reportNotifs(A)).toHaveLength(1)
    expect(reportNotifs(B)).toHaveLength(0)
    expect(reportNotifs(C)).toHaveLength(0)
    expect(reportNotifs(ACTOR)).toHaveLength(0)

    const bell = reportNotifs(A)[0]!
    expect(bell.type).toBe("report_chat")
    expect(bell.link).toBe(`/messages/report/${REPORT}`)
    expect(bell.title).toBe("Dana")
    expect(bell.body).toBe("hello everyone")
  })

  it("a SYSTEM message (no author) notifies all non-present/non-muted members with the title fallback", async () => {
    const members = [A, B, C]
    const present = new Set<string>([B])
    const muted = new Set<string>()

    const notify = makeReportChatNotifier({
      notificationService: notifications,
      reportChatRepo: { listMemberIds: () => Promise.resolve(members) },
      isMuted: (userId) => Promise.resolve(muted.has(userId)),
      presence: { online: () => Promise.resolve([...present]) },
      roomKeyFor,
      isBlockedEitherWay: () => Promise.resolve(false),
    })

    await notify(REPORT, systemMessage())

    expect(reportNotifs(A)).toHaveLength(1)
    expect(reportNotifs(C)).toHaveLength(1)
    expect(reportNotifs(B)).toHaveLength(0)

    expect(reportNotifs(A)[0]!.title).toBe("New message")
    expect(reportNotifs(A)[0]!.link).toBe(`/messages/report/${REPORT}`)
  })

  it("works without a presence dep (no one suppressed) and skips only the actor", async () => {
    const notify = makeReportChatNotifier({
      notificationService: notifications,
      reportChatRepo: { listMemberIds: () => Promise.resolve([A, B, ACTOR]) },
      isMuted: () => Promise.resolve(false),
      roomKeyFor,
      isBlockedEitherWay: () => Promise.resolve(false),
    })

    await notify(REPORT, userMessage(ACTOR, "Dana", "hi"))

    expect(reportNotifs(A)).toHaveLength(1)
    expect(reportNotifs(B)).toHaveLength(1)
    expect(reportNotifs(ACTOR)).toHaveLength(0)
  })

  it("P2 2.5 dedupe: excludes the REPLY TARGET from the fan-out (they get the reply bell instead)", async () => {
    const notify = makeReportChatNotifier({
      notificationService: notifications,
      reportChatRepo: { listMemberIds: () => Promise.resolve([A, B, ACTOR]) },
      isMuted: () => Promise.resolve(false),
      roomKeyFor,
      isBlockedEitherWay: () => Promise.resolve(false),
    })

    await notify(
      REPORT,
      userMessage(ACTOR, "Dana", "replying", { replyTo: replyPreviewFrom(A, "Ann") }),
    )

    expect(reportNotifs(A)).toHaveLength(0)
    expect(reportNotifs(B)).toHaveLength(1)
  })

  it("P2 2.5 dedupe: excludes @-mentioned members from the fan-out (they get the mention bell instead)", async () => {
    const notify = makeReportChatNotifier({
      notificationService: notifications,
      reportChatRepo: { listMemberIds: () => Promise.resolve([A, B, ACTOR]) },
      isMuted: () => Promise.resolve(false),
      roomKeyFor,
      isBlockedEitherWay: () => Promise.resolve(false),
    })

    const mention: UserMentionDTO = { id: B, handle: "bee", displayName: "Bee" }
    await notify(REPORT, userMessage(ACTOR, "Dana", "hey @bee", { mentions: [mention] }))

    expect(reportNotifs(B)).toHaveLength(0)
    expect(reportNotifs(A)).toHaveLength(1)
  })
})

describe("report fan-out mute seam (batch lookup vs per-user fallback)", () => {
  function mutedUserIdsForRoom(
    repo: ConversationMutesRepository,
    kind: "report",
  ): ((roomId: string, userIds: string[]) => Promise<Set<string>>) | undefined {
    const batch = repo.mutedUserIdsFor
    if (!batch) return undefined
    return (roomId, userIds) => batch.call(repo, kind, roomId, userIds)
  }

  function notifierOver(mutes: ConversationMutesRepository) {
    const batch = mutedUserIdsForRoom(mutes, "report")
    return makeReportChatNotifier({
      notificationService: notifications,
      reportChatRepo: { listMemberIds: () => Promise.resolve([A, B, ACTOR]) },
      isMuted: (userId, roomId) => mutes.isMuted(userId, "report", roomId),
      ...(batch ? { mutedUserIdsFor: batch } : {}),
      roomKeyFor,
      isBlockedEitherWay: () => Promise.resolve(false),
    })
  }

  it("a repo WITHOUT mutedUserIdsFor still suppresses a muted member, via the per-user isMuted fallback", async () => {
    const mutes = new InMemoryConversationMutes()
    mutes.mute(B, "report", REPORT)

    await notifierOver(mutes)(REPORT, userMessage(ACTOR, "Dana", "poll time"))

    expect(reportNotifs(A)).toHaveLength(1)
    expect(reportNotifs(B)).toHaveLength(0)
    expect(mutes.isMutedCalls.sort()).toEqual(
      [`${A}|report|${REPORT}`, `${B}|report|${REPORT}`].sort(),
    )
  })

  it("a repo WITH mutedUserIdsFor suppresses via ONE batch query and never calls the per-user isMuted", async () => {
    const mutes = new InMemoryConversationMutesBatch()
    mutes.mute(B, "report", REPORT)

    await notifierOver(mutes)(REPORT, userMessage(ACTOR, "Dana", "poll time"))

    expect(reportNotifs(A)).toHaveLength(1)
    expect(reportNotifs(B)).toHaveLength(0)
    expect(mutes.batchCalls).toEqual([{ roomKind: "report", roomId: REPORT }])
    expect(mutes.isMutedCalls).toEqual([])
  })

  it("an ERRORING batch lookup fails OPEN: a mute store blip must not silence the room", async () => {
    const mutes = new InMemoryConversationMutesBatch()
    mutes.mute(B, "report", REPORT)
    const exploding: ConversationMutesRepository = {
      isMuted: (u, k, r) => mutes.isMuted(u, k, r),
      setMuted: () => Promise.resolve(),
      mutedRoomIdsFor: () => Promise.resolve(new Set<string>()),
      mutedUserIdsFor: () => Promise.reject(new Error("mute store down")),
    }

    await notifierOver(exploding)(REPORT, userMessage(ACTOR, "Dana", "poll time"))

    expect(reportNotifs(A)).toHaveLength(1)
    expect(reportNotifs(B)).toHaveLength(1)
  })
})

describe("DM bell (makeDmBellNotifier: mute gate + P2 2.5 reply override)", () => {
  const THREAD = "22222222-2222-2222-2222-222222222222"

  function makeIsMutedFor(mutes: ConversationMutesRepository | undefined) {
    return async (
      userId: string,
      kind: ConversationMuteRoomKind,
      roomId: string,
    ): Promise<boolean> => {
      if (!mutes) return false
      try {
        return await mutes.isMuted(userId, kind, roomId)
      } catch {
        return false
      }
    }
  }

  function makeOnDmDelivered(mutes: ConversationMutesRepository | undefined) {
    return makeDmBellNotifier({
      notificationService: notifications,
      isMutedFor: makeIsMutedFor(mutes),
    })
  }

  function dmNotifs(userId: string): typeof notifRepo.notifications {
    return notifRepo.notifications.filter((n) => n.userId === userId && n.type === "dm")
  }

  it("SKIPS createNotification when the recipient muted the DM thread (non-reply message)", async () => {
    const mutes = new InMemoryConversationMutes()
    mutes.mute(B, "dm", THREAD)
    const onDmDelivered = makeOnDmDelivered(mutes)

    await onDmDelivered(THREAD, B, userMessage(A, "Alice", "hey"))

    expect(dmNotifs(B)).toHaveLength(0)
  })

  it("still creates the DM bell when the recipient has NOT muted the thread", async () => {
    const mutes = new InMemoryConversationMutes()
    const onDmDelivered = makeOnDmDelivered(mutes)

    await onDmDelivered(THREAD, B, userMessage(A, "Alice", "hey"))

    expect(dmNotifs(B)).toHaveLength(1)
    expect(dmNotifs(B)[0]!.link).toBe(`/messages/dm/${THREAD}`)
    expect(dmNotifs(B)[0]!.title).toBe("Alice")
  })

  it("a reply TO the recipient PIERCES the thread mute (reply-flavored title)", async () => {
    const mutes = new InMemoryConversationMutes()
    mutes.mute(B, "dm", THREAD)
    const onDmDelivered = makeOnDmDelivered(mutes)

    await onDmDelivered(
      THREAD,
      B,
      userMessage(A, "Alice", "re: hey", { replyTo: replyPreviewFrom(B, "Bee") }),
    )

    expect(dmNotifs(B)).toHaveLength(1)
    expect(dmNotifs(B)[0]!.title).toBe("Alice replied to you")
    expect(dmNotifs(B)[0]!.link).toBe(`/messages/dm/${THREAD}`)
  })

  it("the mute-pierce is mention-class: prefs.mentions=false keeps a muted thread silent even for a reply", async () => {
    const mutes = new InMemoryConversationMutes()
    mutes.mute(B, "dm", THREAD)
    await notifications.updatePrefs(B, { mentions: false })
    const onDmDelivered = makeOnDmDelivered(mutes)

    await onDmDelivered(
      THREAD,
      B,
      userMessage(A, "Alice", "re: hey", { replyTo: replyPreviewFrom(B, "Bee") }),
    )

    expect(dmNotifs(B)).toHaveLength(0)
  })

  it("an UNMUTED thread produces exactly ONE dm bell for a reply (no duplicate)", async () => {
    const mutes = new InMemoryConversationMutes()
    const onDmDelivered = makeOnDmDelivered(mutes)

    await onDmDelivered(
      THREAD,
      B,
      userMessage(A, "Alice", "re: hey", { replyTo: replyPreviewFrom(B, "Bee") }),
    )

    expect(dmNotifs(B)).toHaveLength(1)
    expect(dmNotifs(B)[0]!.title).toBe("Alice replied to you")
  })

  it("a reply to the SENDER'S OWN message in a muted thread stays silent for the peer... unless it replies to them", async () => {
    const mutes = new InMemoryConversationMutes()
    mutes.mute(B, "dm", THREAD)
    const onDmDelivered = makeOnDmDelivered(mutes)

    await onDmDelivered(
      THREAD,
      B,
      userMessage(A, "Alice", "self-thread", { replyTo: replyPreviewFrom(A, "Alice") }),
    )

    expect(dmNotifs(B)).toHaveLength(0)
  })
})

describe("F154: the room fan-out asks for a BOUNDED member slice", () => {
  it("passes REPORT_CHAT_FANOUT_MEMBER_CAP to listMemberIds", async () => {
    const limits: (number | undefined)[] = []
    const notify = makeReportChatNotifier({
      notificationService: notifications,
      reportChatRepo: {
        listMemberIds: (_reportId: string, limit?: number) => {
          limits.push(limit)
          return Promise.resolve([A, ACTOR])
        },
      },
      isMuted: () => Promise.resolve(false),
      roomKeyFor,
      isBlockedEitherWay: () => Promise.resolve(false),
    })

    await notify(REPORT, userMessage(ACTOR, "Dana", "hi"))

    expect(limits).toEqual([REPORT_CHAT_FANOUT_MEMBER_CAP])
    expect(REPORT_CHAT_FANOUT_MEMBER_CAP).toBeLessThanOrEqual(500)
  })

  it("delivers at most one bell per member of the capped slice", async () => {
    const roster = Array.from(
      { length: REPORT_CHAT_FANOUT_MEMBER_CAP },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    )
    const notify = makeReportChatNotifier({
      notificationService: notifications,
      reportChatRepo: {
        listMemberIds: (_reportId: string, limit?: number) =>
          Promise.resolve(roster.slice(0, limit ?? roster.length)),
      },
      isMuted: () => Promise.resolve(false),
      roomKeyFor,
      isBlockedEitherWay: () => Promise.resolve(false),
    })

    await notify(REPORT, systemMessage())

    expect(notifRepo.notifications.filter((n) => n.type === "report_chat")).toHaveLength(
      REPORT_CHAT_FANOUT_MEMBER_CAP,
    )
  })
})

describe("F084: the shared room fan-out caps the recipient set", () => {
  it("delivers at most ROOM_FANOUT_MEMBER_CAP bells for an over-sized roster", async () => {
    const roster = Array.from(
      { length: ROOM_FANOUT_MEMBER_CAP + 250 },
      (_, i) => `00000000-0000-4000-9000-${String(i).padStart(12, "0")}`,
    )
    const notify = makeRoomFanoutNotifier(
      { kind: "group", titleFallbackKey: "notification.group_chat.title_fallback" },
      {
        notificationService: notifications,
        listMemberIds: () => Promise.resolve(roster),
        isMuted: () => Promise.resolve(false),
        roomKey: (id) => `group:${id}`,
        isBlockedEitherWay: () => Promise.resolve(false),
      },
    )

    await notify(REPORT, systemMessage())

    expect(notifRepo.notifications.filter((n) => n.type === "group_chat")).toHaveLength(
      ROOM_FANOUT_MEMBER_CAP,
    )
  })
})

class BatchCountingPushSender implements PushSender {
  readonly singleSends: string[] = []
  readonly batches: number[] = []

  registerToken(): Promise<void> {
    return Promise.resolve()
  }

  send(userId: string): Promise<void> {
    this.singleSends.push(userId)
    return Promise.resolve()
  }

  sendMany(userIds: string[]): Promise<void> {
    this.batches.push(userIds.length)
    return Promise.resolve()
  }
}

describe("F084: the shared room fan-out batches push delivery", () => {
  it("delivers an over-100-recipient roster in sendMany batches, never one send per recipient", async () => {
    const roster = Array.from(
      { length: 250 },
      (_, i) => `00000000-0000-4000-a000-${String(i).padStart(12, "0")}`,
    )
    const pushSpy = new BatchCountingPushSender()
    const service = makeNotificationService({ repo: notifRepo, pushSender: pushSpy })
    const notify = makeRoomFanoutNotifier(
      { kind: "group", titleFallbackKey: "notification.group_chat.title_fallback" },
      {
        notificationService: service,
        listMemberIds: () => Promise.resolve(roster),
        isMuted: () => Promise.resolve(false),
        roomKey: (id) => `group:${id}`,
        isBlockedEitherWay: () => Promise.resolve(false),
      },
    )

    await notify(REPORT, systemMessage())

    expect(notifRepo.notifications.filter((n) => n.type === "group_chat")).toHaveLength(
      roster.length,
    )
    await flushNotificationDispatch()
    expect(pushSpy.singleSends).toHaveLength(0)
    await flushNotificationDispatch()
    expect(pushSpy.batches).toEqual([PUSH_FANOUT_BATCH_SIZE, PUSH_FANOUT_BATCH_SIZE, 50])
    await flushNotificationDispatch()
    expect(pushSpy.batches.reduce((a, b) => a + b, 0)).toBe(roster.length)
  })

  it("honours per-recipient prefs when grouping: opted-out members are left out of the batch", async () => {
    const roster = Array.from(
      { length: 120 },
      (_, i) => `00000000-0000-4000-b000-${String(i).padStart(12, "0")}`,
    )
    for (const userId of roster.slice(0, 20)) {
      await notifRepo.upsertPrefs(userId, { cleanupChat: false })
    }
    const pushSpy = new BatchCountingPushSender()
    const service = makeNotificationService({ repo: notifRepo, pushSender: pushSpy })
    const notify = makeRoomFanoutNotifier(
      { kind: "group", titleFallbackKey: "notification.group_chat.title_fallback" },
      {
        notificationService: service,
        listMemberIds: () => Promise.resolve(roster),
        isMuted: () => Promise.resolve(false),
        roomKey: (id) => `group:${id}`,
        isBlockedEitherWay: () => Promise.resolve(false),
      },
    )

    await notify(REPORT, systemMessage())

    expect(notifRepo.notifications.filter((n) => n.type === "group_chat")).toHaveLength(
      roster.length,
    )
    await flushNotificationDispatch()
    expect(pushSpy.singleSends).toHaveLength(0)
    await flushNotificationDispatch()
    expect(pushSpy.batches).toEqual([PUSH_FANOUT_BATCH_SIZE])
  })
})

class UnreadablePrefsRepository extends InMemoryNotificationRepository {
  override findPrefs(): Promise<NotificationPrefsRecord | null> {
    return Promise.reject(new Error("prefs read failed"))
  }
}

class UnreadableBatchPrefsRepository extends InMemoryNotificationRepository {
  findPrefsMany(): Promise<Map<string, NotificationPrefsRecord>> {
    return Promise.reject(new Error("batched prefs read failed"))
  }
}

class BatchPrefsRepository extends InMemoryNotificationRepository {
  readonly batchCalls: number[] = []

  findPrefsMany(userIds: string[]): Promise<Map<string, NotificationPrefsRecord>> {
    this.batchCalls.push(userIds.length)
    const out = new Map<string, NotificationPrefsRecord>()
    for (const userId of userIds) {
      const prefs = this.prefs.get(userId)
      if (prefs) out.set(userId, prefs)
    }
    return Promise.resolve(out)
  }
}

describe("F084: an unreadable prefs row suppresses push (consent gate fails CLOSED)", () => {
  const rosterOf = (n: number, tag: string): string[] =>
    Array.from({ length: n }, (_, i) => `00000000-0000-4000-${tag}-${String(i).padStart(12, "0")}`)

  const fanOutWith = (
    repo: InMemoryNotificationRepository,
    pushSpy: BatchCountingPushSender,
    roster: string[],
  ): ((roomId: string, message: ChatMessageDTO) => Promise<void>) =>
    makeRoomFanoutNotifier(
      { kind: "group", titleFallbackKey: "notification.group_chat.title_fallback" },
      {
        notificationService: makeNotificationService({ repo, pushSender: pushSpy }),
        listMemberIds: () => Promise.resolve(roster),
        isMuted: () => Promise.resolve(false),
        roomKey: (id) => `group:${id}`,
        isBlockedEitherWay: () => Promise.resolve(false),
      },
    )

  it("per-recipient prefs read failure: bells are still written, but nothing is pushed", async () => {
    const roster = rosterOf(120, "c000")
    const repo = new UnreadablePrefsRepository()
    const pushSpy = new BatchCountingPushSender()

    await fanOutWith(repo, pushSpy, roster)(REPORT, systemMessage())

    expect(repo.notifications.filter((n) => n.type === "group_chat")).toHaveLength(roster.length)
    await flushNotificationDispatch()
    expect(pushSpy.batches).toEqual([])
    await flushNotificationDispatch()
    expect(pushSpy.singleSends).toHaveLength(0)
  })

  it("batched prefs read failure: the whole fan-out's push is suppressed, not defaulted open", async () => {
    const roster = rosterOf(120, "d000")
    const repo = new UnreadableBatchPrefsRepository()
    const pushSpy = new BatchCountingPushSender()

    await fanOutWith(repo, pushSpy, roster)(REPORT, systemMessage())

    expect(repo.notifications.filter((n) => n.type === "group_chat")).toHaveLength(roster.length)
    await flushNotificationDispatch()
    expect(pushSpy.batches).toEqual([])
    await flushNotificationDispatch()
    expect(pushSpy.singleSends).toHaveLength(0)
  })

  it("the batched prefs lane is used when the repo offers it, and its opt-outs are honoured", async () => {
    const roster = rosterOf(120, "e000")
    const repo = new BatchPrefsRepository()
    for (const userId of roster.slice(0, 20)) await repo.upsertPrefs(userId, { cleanupChat: false })
    const pushSpy = new BatchCountingPushSender()

    await fanOutWith(repo, pushSpy, roster)(REPORT, systemMessage())

    expect(repo.batchCalls).toEqual([roster.length])
    await flushNotificationDispatch()
    expect(pushSpy.batches).toEqual([PUSH_FANOUT_BATCH_SIZE])
    await flushNotificationDispatch()
    expect(pushSpy.singleSends).toHaveLength(0)
  })
})
