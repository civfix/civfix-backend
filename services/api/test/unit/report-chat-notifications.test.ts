import { describe, it, expect, beforeEach } from "vitest"
import { FakePushSender } from "@civfix/shared/fakes"
import type { ChatMessageDTO, PersonDTO, ReplyToDTO, UserMentionDTO } from "@civfix/shared"
import { makeReportChatNotifier } from "../../src/services/report-chat-notifier.js"
import { makeDmBellNotifier } from "../../src/services/chat-bells.js"
import { InMemoryNotificationRepository } from "../helpers/notifications.js"
import {
  makeNotificationService,
  type NotificationService,
} from "../../src/services/notification-service.js"
import type { ConversationMutesRepository } from "../../src/services/conversation-mutes-repository.drizzle.js"
import type { ConversationMuteRoomKind } from "../../src/db/schema/conversation_mutes.js"

/**
 * In-memory ConversationMutesRepository mirroring the Drizzle one's isMuted semantics (row exists ⇒ muted).
 *
 * Deliberately does NOT implement the OPTIONAL `mutedUserIdsFor` batch member lookup: it is the stand-in
 * for the pre-batch fakes the interface keeps that member optional for, and the fan-out's per-candidate
 * `isMuted` fallback has to keep working for them (pinned below in "report fan-out mute seam").
 */
class InMemoryConversationMutes implements ConversationMutesRepository {
  private readonly muted = new Set<string>()
  /** Every isMuted lookup, so a test can tell the per-user fallback from the batch path. */
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

/** The same store, plus the batch member lookup the Drizzle repo implements. */
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

/** A hydrated reply preview whose target was sent by `senderId`. */
function replyPreviewFrom(senderId: string, senderName: string): ReplyToDTO {
  return { id: "target-1", from: { id: senderId, displayName: senderName }, excerpt: "orig", kind: "text" }
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
    const present = new Set([B]) // B is viewing the room live
    const muted = new Set([C]) // C muted this report chat

    const notify = makeReportChatNotifier({
      notificationService: notifications,
      reportChatRepo: { listMemberIds: () => Promise.resolve(members) },
      isMuted: (userId) => Promise.resolve(muted.has(userId)),
      presence: { online: () => Promise.resolve([...present]) },
      roomKeyFor,
      isBlockedEitherWay: () => Promise.resolve(false), // offline harness: no blocks store
    })

    await notify(REPORT, userMessage(ACTOR, "Dana", "hello everyone"))

    // Only A gets a bell.
    expect(reportNotifs(A)).toHaveLength(1)
    expect(reportNotifs(B)).toHaveLength(0) // present
    expect(reportNotifs(C)).toHaveLength(0) // muted
    expect(reportNotifs(ACTOR)).toHaveLength(0) // sender

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
      isBlockedEitherWay: () => Promise.resolve(false), // offline harness: no blocks store
    })

    await notify(REPORT, systemMessage())

    // A and C get bells (B is present); no sender to skip.
    expect(reportNotifs(A)).toHaveLength(1)
    expect(reportNotifs(C)).toHaveLength(1)
    expect(reportNotifs(B)).toHaveLength(0)

    // System message has no author name -> localized fallback title ("New message" in en).
    expect(reportNotifs(A)[0]!.title).toBe("New message")
    expect(reportNotifs(A)[0]!.link).toBe(`/messages/report/${REPORT}`)
  })

  it("works without a presence dep (no one suppressed) and skips only the actor", async () => {
    const notify = makeReportChatNotifier({
      notificationService: notifications,
      reportChatRepo: { listMemberIds: () => Promise.resolve([A, B, ACTOR]) },
      isMuted: () => Promise.resolve(false),
      roomKeyFor,
      isBlockedEitherWay: () => Promise.resolve(false), // offline harness: no blocks store
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
      isBlockedEitherWay: () => Promise.resolve(false), // offline harness: no blocks store
    })

    // ACTOR replies to A's message: A is excluded from the member fan-out; B still gets it.
    await notify(REPORT, userMessage(ACTOR, "Dana", "replying", { replyTo: replyPreviewFrom(A, "Ann") }))

    expect(reportNotifs(A)).toHaveLength(0)
    expect(reportNotifs(B)).toHaveLength(1)
  })

  it("P2 2.5 dedupe: excludes @-mentioned members from the fan-out (they get the mention bell instead)", async () => {
    const notify = makeReportChatNotifier({
      notificationService: notifications,
      reportChatRepo: { listMemberIds: () => Promise.resolve([A, B, ACTOR]) },
      isMuted: () => Promise.resolve(false),
      roomKeyFor,
      isBlockedEitherWay: () => Promise.resolve(false), // offline harness: no blocks store
    })

    const mention: UserMentionDTO = { id: B, handle: "bee", displayName: "Bee" }
    await notify(REPORT, userMessage(ACTOR, "Dana", "hey @bee", { mentions: [mention] }))

    expect(reportNotifs(B)).toHaveLength(0)
    expect(reportNotifs(A)).toHaveLength(1)
  })
})

/**
 * The mute seam has TWO shapes and the fan-out must honour a mute through either. `mutedUserIdsFor` is
 * OPTIONAL on ConversationMutesRepository (the offline fakes predate it), and the fan-out treats a PRESENT
 * batch lookup as authoritative — skipping the per-candidate `isMuted` entirely. So:
 *
 *   - a repo WITHOUT the batch method must not be wired into the batch slot at all (a bound-but-absent
 *     method resolving to an empty Set would silently unmute the entire room), and the per-user fallback
 *     must carry the mute;
 *   - a repo WITH it must be used, once, for the whole candidate set.
 *
 * `mutedUserIdsForRoom` below is the production probe from chat-gateway-wiring.ts, copied so the wiring
 * decision itself is under test rather than assumed.
 */
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
    // The fallback really ran: one lookup per candidate (the actor is filtered out before the gate).
    expect(mutes.isMutedCalls.sort()).toEqual([`${A}|report|${REPORT}`, `${B}|report|${REPORT}`].sort())
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

    // Everyone gets the bell — including B, whose mute could not be read.
    expect(reportNotifs(A)).toHaveLength(1)
    expect(reportNotifs(B)).toHaveLength(1)
  })
})

// The DM delivered bell — the REAL production factory (chat-bells makeDmBellNotifier, wired as
// onDmDelivered) over the real notification service + the in-memory mute repo mirroring the Drizzle
// isMuted. P2 2.5 adds the reply override: a reply TO the recipient pierces a muted thread.
describe("DM bell (makeDmBellNotifier: mute gate + P2 2.5 reply override)", () => {
  const THREAD = "22222222-2222-2222-2222-222222222222"

  // Mirrors the production `isMutedFor` helper in chat-gateway-wiring.ts (absent repo ⇒ false; swallow errors).
  function makeIsMutedFor(mutes: ConversationMutesRepository | undefined) {
    return async (userId: string, kind: ConversationMuteRoomKind, roomId: string): Promise<boolean> => {
      if (!mutes) return false
      try {
        return await mutes.isMuted(userId, kind, roomId)
      } catch {
        return false
      }
    }
  }

  function makeOnDmDelivered(mutes: ConversationMutesRepository | undefined) {
    return makeDmBellNotifier({ notificationService: notifications, isMutedFor: makeIsMutedFor(mutes) })
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

    await onDmDelivered(THREAD, B, userMessage(A, "Alice", "re: hey", { replyTo: replyPreviewFrom(B, "Bee") }))

    expect(dmNotifs(B)).toHaveLength(1)
    expect(dmNotifs(B)[0]!.title).toBe("Alice replied to you")
    expect(dmNotifs(B)[0]!.link).toBe(`/messages/dm/${THREAD}`)
  })

  it("the mute-pierce is mention-class: prefs.mentions=false keeps a muted thread silent even for a reply", async () => {
    const mutes = new InMemoryConversationMutes()
    mutes.mute(B, "dm", THREAD)
    await notifications.updatePrefs(B, { mentions: false })
    const onDmDelivered = makeOnDmDelivered(mutes)

    await onDmDelivered(THREAD, B, userMessage(A, "Alice", "re: hey", { replyTo: replyPreviewFrom(B, "Bee") }))

    expect(dmNotifs(B)).toHaveLength(0)
  })

  it("an UNMUTED thread produces exactly ONE dm bell for a reply (no duplicate)", async () => {
    const mutes = new InMemoryConversationMutes()
    const onDmDelivered = makeOnDmDelivered(mutes)

    await onDmDelivered(THREAD, B, userMessage(A, "Alice", "re: hey", { replyTo: replyPreviewFrom(B, "Bee") }))

    expect(dmNotifs(B)).toHaveLength(1)
    expect(dmNotifs(B)[0]!.title).toBe("Alice replied to you")
  })

  it("a reply to the SENDER'S OWN message in a muted thread stays silent for the peer... unless it replies to them", async () => {
    const mutes = new InMemoryConversationMutes()
    mutes.mute(B, "dm", THREAD)
    const onDmDelivered = makeOnDmDelivered(mutes)

    // A replies to A's own earlier message: not a reply TO B, so the mute holds.
    await onDmDelivered(THREAD, B, userMessage(A, "Alice", "self-thread", { replyTo: replyPreviewFrom(A, "Alice") }))

    expect(dmNotifs(B)).toHaveLength(0)
  })
})
