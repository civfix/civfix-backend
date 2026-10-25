// GH#224: a chat @mention or reply is a `chat_mention` row gated only by Mentions and replies, a muted
// DM thread's reply bell needs that category on, and every chat bell names its conversation (D10).

import { beforeEach, describe, expect, it } from "vitest"
import type { ChatMessageDTO, ReplyToDTO, ReportCategory } from "@civfix/contract"
import {
  makeChatMentionNotifier,
  makeChatReplyNotifier,
  makeDmBellNotifier,
  type ChatBellDeps,
} from "../../src/services/chat-bells.js"
import {
  ROOM_FANOUT_SPEC,
  runRoomFanout,
  type RoomFanoutNotifierDeps,
} from "../../src/services/chat-room-fanout-notifier.js"
import type { ConversationNameLookups } from "../../src/services/conversation-names.js"
import { DEFAULT_PREFS } from "../../src/services/notification-service.js"
import { flushNotificationDispatch } from "../helpers/notifications.js"
import {
  captureNotifications,
  categoryOfInput,
  OFF,
  type NotificationCapture,
} from "../helpers/notification-capture.js"

const A = "aaaaaaaa-0000-4000-8000-000000000001"
const B = "bbbbbbbb-0000-4000-8000-000000000002"
const C = "cccccccc-0000-4000-8000-000000000003"
const G = "99999999-0000-4000-8000-000000000001"
const R = "99999999-0000-4000-8000-000000000002"
const E = "99999999-0000-4000-8000-000000000003"
const T = "99999999-0000-4000-8000-000000000004"

const NAMES: ConversationNameLookups = {
  groupName: (id) => Promise.resolve(id === G ? "Eastside crew" : null),
  reportCategory: (id) => Promise.resolve(id === R ? ("pothole" satisfies ReportCategory) : null),
  eventTitle: (id) => Promise.resolve(id === E ? "Lake Balboa cleanup" : null),
}

function message(opts: { mentions?: string[]; replyToId?: string } = {}): ChatMessageDTO {
  const replyTo: ReplyToDTO | undefined =
    opts.replyToId !== undefined
      ? {
          id: "target-1",
          from: { id: opts.replyToId, displayName: "Bea" },
          excerpt: "x",
          kind: "text",
        }
      : undefined
  return {
    id: "msg-1",
    cleanupId: G,
    from: { id: A, name: "Ana", followers: 0, following: 0, isFollowing: false },
    body: "see you there",
    kind: "text",
    reactions: [],
    mentions: (opts.mentions ?? []).map((id) => ({ id, handle: "bea", displayName: "Bea" })),
    createdAt: new Date().toISOString(),
    ...(replyTo !== undefined ? { replyToId: replyTo.id, replyTo } : {}),
  }
}

let n: NotificationCapture
let muted: Set<string>

function bellDeps(): ChatBellDeps {
  return {
    notificationService: n.service,
    isMutedFor: (userId, kind, roomId) => Promise.resolve(muted.has(`${userId}|${kind}|${roomId}`)),
    isCleanupMember: () => Promise.resolve(true),
    isReportChatMember: () => Promise.resolve(true),
    isChatGroupMember: () => Promise.resolve(true),
    isBlockedEitherWay: () => Promise.resolve(false),
    roomKeyFor: (kind, id) => `${kind}:${id}`,
    conversationNames: NAMES,
  }
}

function fanoutDeps(members: string[]): RoomFanoutNotifierDeps {
  return {
    notificationService: n.service,
    listMemberIds: () => Promise.resolve(members),
    isMuted: () => Promise.resolve(false),
    roomKey: (id) => id,
    isBlockedEitherWay: () => Promise.resolve(false),
    conversationNames: NAMES,
  }
}

function mention(kind: "group" | "report" | "cleanup", roomId: string): Promise<void> {
  return makeChatMentionNotifier(bellDeps())({
    kind,
    roomId,
    actorUserId: A,
    mentionedUserId: B,
    message: message({ mentions: [B] }),
  })
}

function dmBell(msg: ChatMessageDTO): Promise<void> {
  return makeDmBellNotifier(bellDeps())(T, B, msg)
}

beforeEach(() => {
  n = captureNotifications()
  muted = new Set()
})

describe("makeChatMentionNotifier", () => {
  it("T1: a group mention is one chat_mention bell named after the group", async () => {
    await mention("group", G)
    expect(n.inputs).toHaveLength(1)
    expect(n.inputs[0]).toMatchObject({
      userIds: [B],
      input: {
        type: "chat_mention",
        link: `/messages/group/${G}`,
        conversationName: "Eastside crew",
      },
    })
    expect(n.rows(B).map((r) => r.type)).toEqual(["chat_mention"])
  })

  it("T2: a report mention is named after the report's category label", async () => {
    await mention("report", R)
    expect(n.inputs[0]?.input).toMatchObject({
      type: "chat_mention",
      link: `/messages/report/${R}`,
      conversationName: "Pothole",
    })
  })

  it("T3: an event-room mention is named after the event's title", async () => {
    await mention("cleanup", E)
    expect(n.inputs[0]?.input).toMatchObject({
      type: "chat_mention",
      link: `/cleanups/${E}`,
      conversationName: "Lake Balboa cleanup",
    })
  })

  it("T4: Mentions and replies Off stores nothing and pushes nothing", async () => {
    await n.set(B, "mentions", OFF)
    await mention("group", G)
    await flushNotificationDispatch()
    expect(n.rows(B)).toEqual([])
    expect(n.pushesTo(B)).toEqual([])
  })

  it("T5: the old notification_prefs.mentions boolean is not read", async () => {
    n.repo.prefs.set(B, { ...DEFAULT_PREFS, mentions: false })
    await mention("group", G)
    expect(n.rows(B).map((r) => r.type)).toEqual(["chat_mention"])
  })
})

describe("makeChatReplyNotifier", () => {
  const reply = () =>
    makeChatReplyNotifier(bellDeps())({
      kind: "group",
      roomId: G,
      actorUserId: A,
      targetUserId: B,
      message: message({ replyToId: B }),
    })

  it("T6: a reply to an absent member is a chat_mention reply bell named after the group", async () => {
    await reply()
    expect(n.inputs).toHaveLength(1)
    expect(n.inputs[0]).toMatchObject({
      userIds: [B],
      input: {
        type: "chat_mention",
        titleKey: "notification.chat_reply.title",
        link: `/messages/group/${G}`,
        conversationName: "Eastside crew",
      },
    })
  })

  it("T7: Mentions and replies Off stores nothing", async () => {
    await n.set(B, "mentions", OFF)
    await reply()
    expect(n.rows(B)).toEqual([])
  })
})

describe("makeDmBellNotifier", () => {
  it("T8: an unmuted reply is a dm reply bell named after the author", async () => {
    await dmBell(message({ replyToId: B }))
    expect(n.inputs).toHaveLength(1)
    expect(n.inputs[0]).toMatchObject({
      userIds: [B],
      input: {
        type: "dm",
        titleKey: "notification.chat_reply.title",
        link: `/messages/dm/${T}`,
        conversationName: "Ana",
      },
    })
  })

  it("T9: a reply in a muted thread bells with default settings", async () => {
    muted.add(`${B}|dm|${T}`)
    await dmBell(message({ replyToId: B }))
    expect(n.rows(B).map((r) => r.type)).toEqual(["dm"])
  })

  it("T10: a reply in a muted thread does not bell with Mentions and replies Off", async () => {
    muted.add(`${B}|dm|${T}`)
    await n.set(B, "mentions", OFF)
    await dmBell(message({ replyToId: B }))
    expect(n.rows(B)).toEqual([])
  })

  it("T11: a message that is not a reply does not bell in a muted thread", async () => {
    muted.add(`${B}|dm|${T}`)
    await dmBell(message())
    expect(n.rows(B)).toEqual([])
  })

  it("T12: a muted-thread reply does not bell with Direct messages Off", async () => {
    muted.add(`${B}|dm|${T}`)
    await n.set(B, "mentions", [true, true, false])
    await n.set(B, "directMessages", OFF)
    await dmBell(message({ replyToId: B }))
    expect(n.rows(B)).toEqual([])
  })
})

describe("runRoomFanout", () => {
  it("T13: a group fan-out is one group_chat call named after the group", async () => {
    await runRoomFanout(ROOM_FANOUT_SPEC.group, fanoutDeps([A, B, C]), G, message())
    expect(n.inputs).toHaveLength(1)
    expect(n.inputs[0]).toMatchObject({
      userIds: [B, C],
      input: {
        type: "group_chat",
        link: `/messages/group/${G}`,
        conversationName: "Eastside crew",
      },
    })
  })

  it("T14: a report fan-out is named after the report's category label", async () => {
    await runRoomFanout(ROOM_FANOUT_SPEC.report, fanoutDeps([A, B]), R, message())
    expect(n.inputs[0]?.input).toMatchObject({ type: "report_chat", conversationName: "Pothole" })
  })
})

describe("per-path category", () => {
  it("T46: a report timeline system message's room fan-out is Report discussions", async () => {
    const system: ChatMessageDTO = {
      ...message(),
      from: null,
      kind: "system",
      body: "Status changed to in_progress",
      system: { status: "in_progress" },
    }
    await runRoomFanout(ROOM_FANOUT_SPEC.report, fanoutDeps([B]), R, system)
    expect(n.inputs.map((c) => categoryOfInput(c.input))).toEqual(["reportDiscussions"])
  })

  it("T47: the DM bell is Direct messages", async () => {
    await dmBell(message())
    expect(n.inputs.map((c) => categoryOfInput(c.input))).toEqual(["directMessages"])
  })

  it("T49: a group room fan-out is Group chats", async () => {
    await runRoomFanout(ROOM_FANOUT_SPEC.group, fanoutDeps([A, B]), G, message())
    expect(n.inputs.map((c) => categoryOfInput(c.input))).toEqual(["groupChats"])
  })
})
