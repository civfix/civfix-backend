/**
 * Offline gateway test for CHAT @-mentions (B2): a `send` frame whose body @mentions a user (and/or carries
 * mentionedUserIds) is resolved via the injected GatewayChatMentions seam, persisted (recordChatMentions),
 * PROJECTED onto the broadcast + ack ChatMessageDTO.mentions, and the mentioned user is notified
 * (notifyChatMention). Drives the REAL handleClientFrame over the real WsChatService + an in-memory pub/sub,
 * mirroring chat-realtime.test.ts. The seam is a spy so the persist/notify wiring is asserted with no DB.
 */

import { describe, it, expect, beforeEach } from "vitest"
import {
  handleClientFrame,
  type GatewaySession,
  type GatewayDeps,
  type GatewayChatMentions,
} from "../../src/ws/gateway.js"
import { WsChatService } from "../../src/adapters/chat-service.ws.js"
import { InMemoryChatPubSub } from "../../src/adapters/chat-pubsub.js"
import { InMemoryChatRepository, MockConnection } from "../helpers/chat.js"
import type { ChatMessageDTO, UserMentionDTO } from "@civfix/shared"

const ROOM = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
const ALICE = "11111111-1111-1111-1111-111111111111"
const BOB = "22222222-2222-2222-2222-222222222222"

function memberOf(cleanupId: string, userId: string): Promise<boolean> {
  const members = new Set([ALICE, BOB])
  return Promise.resolve(cleanupId === ROOM && members.has(userId))
}

let chat: WsChatService
let repo: InMemoryChatRepository

/** A spy chat-mention seam: resolves @bob -> Bob, records the persisted ids, captures notify calls. */
function spyMentions() {
  const recorded: Array<{ messageId: string; ids: string[] }> = []
  const notified: Array<{ mentionedUserId: string; actorUserId: string; roomId: string }> = []
  const dir: Record<string, UserMentionDTO> = {
    bob: { id: BOB, handle: "bob", displayName: "Bob" },
    alice: { id: ALICE, handle: "alice", displayName: "Alice" },
  }
  const seam: GatewayChatMentions = {
    resolveChatMentions: ({ handles, userIds, authorUserId }) => {
      const out: UserMentionDTO[] = []
      const seen = new Set<string>()
      for (const h of handles) {
        const u = dir[h.toLowerCase()]
        if (u && u.id !== authorUserId && !seen.has(u.id)) {
          seen.add(u.id)
          out.push(u)
        }
      }
      for (const id of userIds) {
        const u = Object.values(dir).find((d) => d.id === id)
        if (u && u.id !== authorUserId && !seen.has(u.id)) {
          seen.add(u.id)
          out.push(u)
        }
      }
      return Promise.resolve(out)
    },
    recordChatMentions: (messageId, ids) => {
      recorded.push({ messageId, ids })
      return Promise.resolve()
    },
    notifyChatMention: (input) => {
      notified.push({
        mentionedUserId: input.mentionedUserId,
        actorUserId: input.actorUserId,
        roomId: input.roomId,
      })
      return Promise.resolve()
    },
  }
  return { seam, recorded, notified }
}

function sessionFor(userId: string, conn: MockConnection, mentions: GatewayChatMentions): GatewaySession {
  const deps: GatewayDeps = { chat, isMember: memberOf, chatMentions: mentions }
  return { userId, conn, joined: new Set<string>(), typingThrottle: new Map<string, number>(), deps }
}

beforeEach(() => {
  repo = new InMemoryChatRepository()
  repo.registerSender({ id: ALICE, displayName: "Alice", handle: "alice" })
  repo.registerSender({ id: BOB, displayName: "Bob", handle: "bob" })
  chat = new WsChatService({ repo, pubsub: new InMemoryChatPubSub() })
})

describe("chat @-mentions over the gateway send path", () => {
  it("resolves, persists, projects onto broadcast+ack, and notifies the mentioned user", async () => {
    const { seam, recorded, notified } = spyMentions()
    const aConn = new MockConnection("A")
    const bConn = new MockConnection("B")
    const aSession = sessionFor(ALICE, aConn, seam)
    const bSession = sessionFor(BOB, bConn, seam)
    await handleClientFrame(aSession, JSON.stringify({ type: "join", cleanupId: ROOM }))
    await handleClientFrame(bSession, JSON.stringify({ type: "join", cleanupId: ROOM }))

    await handleClientFrame(
      aSession,
      JSON.stringify({ type: "send", cleanupId: ROOM, body: "hey @bob look", clientId: "c1" }),
    )

    // The broadcast {type:"message"} frame B received carries the resolved mention.
    const msgFrame = bConn.framesOfType("message").at(-1) as { message: ChatMessageDTO } | undefined
    expect(msgFrame?.message.mentions.map((m) => m.id)).toEqual([BOB])
    // A's ack also carries the projected mention.
    const ackFrame = aConn.framesOfType("ack").at(-1) as { message: ChatMessageDTO } | undefined
    expect(ackFrame?.message.mentions.map((m) => m.id)).toEqual([BOB])
    // Persisted + notified exactly once for Bob (the author Alice is excluded).
    expect(recorded).toHaveLength(1)
    expect(recorded[0]!.ids).toEqual([BOB])
    expect(notified).toEqual([{ mentionedUserId: BOB, actorUserId: ALICE, roomId: ROOM }])
  })

  it("carries empty mentions + fires no notify when the body names no one", async () => {
    const { seam, recorded, notified } = spyMentions()
    const aConn = new MockConnection("A")
    const aSession = sessionFor(ALICE, aConn, seam)
    await handleClientFrame(aSession, JSON.stringify({ type: "join", cleanupId: ROOM }))
    await handleClientFrame(
      aSession,
      JSON.stringify({ type: "send", cleanupId: ROOM, body: "plain message", clientId: "c2" }),
    )
    const ackFrame = aConn.framesOfType("ack").at(-1) as { message: ChatMessageDTO } | undefined
    expect(ackFrame?.message.mentions).toEqual([])
    expect(recorded).toHaveLength(0)
    expect(notified).toHaveLength(0)
  })

  it("does not self-notify when the sender @mentions themselves", async () => {
    const { seam, notified } = spyMentions()
    const aConn = new MockConnection("A")
    const aSession = sessionFor(ALICE, aConn, seam)
    await handleClientFrame(aSession, JSON.stringify({ type: "join", cleanupId: ROOM }))
    await handleClientFrame(
      aSession,
      JSON.stringify({ type: "send", cleanupId: ROOM, body: "note to @alice", clientId: "c3" }),
    )
    const ackFrame = aConn.framesOfType("ack").at(-1) as { message: ChatMessageDTO } | undefined
    expect(ackFrame?.message.mentions).toEqual([])
    expect(notified).toHaveLength(0)
  })
})
