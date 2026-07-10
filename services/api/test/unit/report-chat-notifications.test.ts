import { describe, it, expect, beforeEach } from "vitest"
import { FakePushSender } from "@civfix/shared/fakes"
import type { ChatMessageDTO, PersonDTO } from "@civfix/shared"
import { makeReportChatNotifier } from "../../src/services/report-chat-notifier.js"
import { InMemoryNotificationRepository } from "../helpers/notifications.js"
import {
  makeNotificationService,
  type NotificationService,
} from "../../src/services/notification-service.js"
import type { ConversationMutesRepository } from "../../src/services/conversation-mutes-repository.drizzle.js"
import type { ConversationMuteRoomKind } from "../../src/db/schema/conversation_mutes.js"
import { dmAuthorName, textPreview } from "../../src/routes/chat-notify-copy.js"

/** In-memory ConversationMutesRepository mirroring the Drizzle one's isMuted semantics (row exists ⇒ muted). */
class InMemoryConversationMutes implements ConversationMutesRepository {
  private readonly muted = new Set<string>()
  private key(u: string, k: ConversationMuteRoomKind, r: string): string {
    return `${u}|${k}|${r}`
  }
  mute(userId: string, roomKind: ConversationMuteRoomKind, roomId: string): void {
    this.muted.add(this.key(userId, roomKind, roomId))
  }
  isMuted(userId: string, roomKind: ConversationMuteRoomKind, roomId: string): Promise<boolean> {
    return Promise.resolve(this.muted.has(this.key(userId, roomKind, roomId)))
  }
  setMuted(): Promise<void> {
    return Promise.resolve()
  }
  mutedRoomIdsFor(): Promise<Set<string>> {
    return Promise.resolve(new Set())
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

function userMessage(fromId: string, name: string, body: string): ChatMessageDTO {
  return {
    id: "msg-1",
    cleanupId: REPORT,
    roomKind: "report",
    from: person(fromId, name),
    body,
    kind: "text",
    reactions: [],
    mentions: [],
    createdAt: new Date().toISOString(),
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
    const present = new Set([B]) // B is viewing the room live
    const muted = new Set([C]) // C muted this report chat

    const notify = makeReportChatNotifier({
      notificationService: notifications,
      reportChatRepo: { listMemberIds: () => Promise.resolve(members) },
      isMuted: (userId) => Promise.resolve(muted.has(userId)),
      presence: { online: () => Promise.resolve([...present]) },
      roomKeyFor,
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
    })

    await notify(REPORT, userMessage(ACTOR, "Dana", "hi"))

    expect(reportNotifs(A)).toHaveLength(1)
    expect(reportNotifs(B)).toHaveLength(1)
    expect(reportNotifs(ACTOR)).toHaveLength(0)
  })
})

// The DM bell gate (chat-gateway-wiring onDmDelivered): `if (await isMutedFor(recipient,"dm",thread)) return`
// before createNotification. Reproduced here at the closure/contract level (the closure is inline in the
// wiring) over the REAL notification service + the in-memory mute repo mirroring the Drizzle isMuted.
describe("DM bell mute gate (D-E2)", () => {
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

  // Mirrors the production `onDmDelivered` closure body (mute gate + createNotification).
  function makeOnDmDelivered(isMutedFor: ReturnType<typeof makeIsMutedFor>) {
    return async (threadId: string, recipientId: string, message: ChatMessageDTO): Promise<void> => {
      if (await isMutedFor(recipientId, "dm", threadId)) return
      const name = dmAuthorName(message)
      const preview = textPreview(message)
      await notifications.createNotification(recipientId, {
        type: "dm",
        ...(name !== "" ? { title: name } : { titleKey: "notification.dm.title_fallback" }),
        ...(preview !== null ? { body: preview } : { bodyKey: "notification.message.no_preview" }),
        link: `/messages/dm/${threadId}`,
      })
    }
  }

  function dmNotifs(userId: string): typeof notifRepo.notifications {
    return notifRepo.notifications.filter((n) => n.userId === userId && n.type === "dm")
  }

  it("SKIPS createNotification when the recipient muted the DM thread", async () => {
    const mutes = new InMemoryConversationMutes()
    mutes.mute(B, "dm", THREAD)
    const onDmDelivered = makeOnDmDelivered(makeIsMutedFor(mutes))

    await onDmDelivered(THREAD, B, userMessage(A, "Alice", "hey"))

    expect(dmNotifs(B)).toHaveLength(0)
  })

  it("still creates the DM bell when the recipient has NOT muted the thread", async () => {
    const mutes = new InMemoryConversationMutes()
    const onDmDelivered = makeOnDmDelivered(makeIsMutedFor(mutes))

    await onDmDelivered(THREAD, B, userMessage(A, "Alice", "hey"))

    expect(dmNotifs(B)).toHaveLength(1)
    expect(dmNotifs(B)[0]!.link).toBe(`/messages/dm/${THREAD}`)
    expect(dmNotifs(B)[0]!.title).toBe("Alice")
  })
})
