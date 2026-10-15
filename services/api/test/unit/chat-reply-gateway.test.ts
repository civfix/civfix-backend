/**
 * Replies at the WS layer: drives the REAL handleClientFrame over the real WsChatService + in-memory
 * pub/sub + InMemoryChatRepository (which mirrors the drizzle reply validation/hydration), asserting
 * that:
 *
 *   - a `send` frame carrying replyToId persists the reply and BOTH the ack and the broadcast frame
 *     carry replyToId + the hydrated replyTo preview;
 *   - the reply bell seam (deps.onChatReply) fires exactly once for the target message's
 *     sender, and NOT when the author replies to their own message;
 *   - MENTION-vs-REPLY DEDUPE: when the replied-to user is also @-mentioned in the same message, the
 *     mention bell (notifyChatMention) is suppressed for that user (the mention is still RECORDED
 *     and projected), while a different mentioned user still gets their mention bell;
 *   - a replyToId pointing nowhere surfaces the machine subcode as a room-stamped error frame
 *     (reply_wrong_room) and produces no ack.
 */

import { describe, it, expect, beforeEach } from "vitest"
import {
  handleClientFrame,
  type GatewaySession,
  type GatewayDeps,
  type GatewayChatMentions,
  type OnChatReply,
} from "../../src/ws/gateway.js"
import { WsChatService } from "../../src/adapters/chat-service.ws.js"
import { InMemoryChatPubSub } from "../../src/adapters/chat-pubsub.js"
import { InMemoryChatRepository, MockConnection } from "../helpers/chat.js"
import type { ChatMessageDTO, UserMentionDTO } from "@civfix/shared"

const ROOM = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
const ALICE = "11111111-1111-1111-1111-111111111111"
const BOB = "22222222-2222-2222-2222-222222222222"
const CARA = "33333333-3333-3333-3333-333333333333"

function memberOf(cleanupId: string, userId: string): Promise<boolean> {
  return Promise.resolve(cleanupId === ROOM && [ALICE, BOB, CARA].includes(userId))
}

let chat: WsChatService
let repo: InMemoryChatRepository

/** Spy mention seam (resolves @bob/@cara) + spy reply seam. */
function spySeams() {
  const recorded: Array<{ messageId: string; ids: string[] }> = []
  const mentionBells: string[] = []
  const replyBells: Array<{
    kind: string
    roomId: string
    actorUserId: string
    targetUserId: string
  }> = []
  const dir: Record<string, UserMentionDTO> = {
    bob: { id: BOB, handle: "bob", displayName: "Bob" },
    cara: { id: CARA, handle: "cara", displayName: "Cara" },
  }
  const chatMentions: GatewayChatMentions = {
    resolveChatMentions: ({ handles, authorUserId }) => {
      const out: UserMentionDTO[] = []
      for (const h of handles) {
        const u = dir[h.toLowerCase()]
        if (u && u.id !== authorUserId && !out.some((m) => m.id === u.id)) out.push(u)
      }
      return Promise.resolve(out)
    },
    recordChatMentions: (messageId, ids) => {
      recorded.push({ messageId, ids })
      return Promise.resolve()
    },
    notifyChatMention: (input) => {
      mentionBells.push(input.mentionedUserId)
      return Promise.resolve()
    },
  }
  const onChatReply: OnChatReply = (input) => {
    replyBells.push({
      kind: input.kind,
      roomId: input.roomId,
      actorUserId: input.actorUserId,
      targetUserId: input.targetUserId,
    })
    return Promise.resolve()
  }
  return { chatMentions, onChatReply, recorded, mentionBells, replyBells }
}

function sessionFor(
  userId: string,
  conn: MockConnection,
  seams: { chatMentions: GatewayChatMentions; onChatReply: OnChatReply },
): GatewaySession {
  const deps: GatewayDeps = {
    chat,
    isMember: memberOf,
    chatMentions: seams.chatMentions,
    onChatReply: seams.onChatReply,
  }
  return {
    userId,
    conn,
    joined: new Set<string>(),
    typingThrottle: new Map<string, number>(),
    deps,
  }
}

/** Flush the fire-and-forget bell microtasks queued by handleSend. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  repo = new InMemoryChatRepository()
  repo.registerSender({ id: ALICE, displayName: "Alice", handle: "alice" })
  repo.registerSender({ id: BOB, displayName: "Bob", handle: "bob" })
  repo.registerSender({ id: CARA, displayName: "Cara", handle: "cara" })
  chat = new WsChatService({ repo, pubsub: new InMemoryChatPubSub() })
})

describe("replies over the gateway send path (P2 2.5)", () => {
  it("ack + broadcast carry replyToId and the hydrated replyTo; the reply bell fires for the target's sender", async () => {
    const seams = spySeams()
    const aConn = new MockConnection("A")
    const bConn = new MockConnection("B")
    const aSession = sessionFor(ALICE, aConn, seams)
    const bSession = sessionFor(BOB, bConn, seams)
    await handleClientFrame(aSession, JSON.stringify({ type: "join", cleanupId: ROOM }))
    await handleClientFrame(bSession, JSON.stringify({ type: "join", cleanupId: ROOM }))

    await handleClientFrame(
      aSession,
      JSON.stringify({ type: "send", cleanupId: ROOM, body: "original text", clientId: "c1" }),
    )
    const originalAck = aConn.framesOfType("ack").at(-1) as { message: ChatMessageDTO }
    const originalId = originalAck.message.id

    await handleClientFrame(
      bSession,
      JSON.stringify({
        type: "send",
        cleanupId: ROOM,
        body: "a reply",
        clientId: "c2",
        replyToId: originalId,
      }),
    )
    await flush()

    const ack = bConn.framesOfType("ack").at(-1) as { message: ChatMessageDTO }
    expect(ack.message.replyToId).toBe(originalId)
    expect(ack.message.replyTo).toMatchObject({
      id: originalId,
      excerpt: "original text",
      kind: "text",
      from: { id: ALICE, displayName: "Alice" },
    })

    const broadcast = aConn.framesOfType("message").at(-1) as { message: ChatMessageDTO }
    expect(broadcast.message.replyToId).toBe(originalId)
    expect(broadcast.message.replyTo).toMatchObject({
      id: originalId,
      excerpt: "original text",
      from: { id: ALICE, displayName: "Alice" },
    })

    expect(seams.replyBells).toEqual([
      { kind: "cleanup", roomId: ROOM, actorUserId: BOB, targetUserId: ALICE },
    ])
    expect(seams.mentionBells).toEqual([])
  })

  it("replying to your OWN message fires no reply bell", async () => {
    const seams = spySeams()
    const aConn = new MockConnection("A")
    const aSession = sessionFor(ALICE, aConn, seams)
    await handleClientFrame(aSession, JSON.stringify({ type: "join", cleanupId: ROOM }))

    await handleClientFrame(
      aSession,
      JSON.stringify({ type: "send", cleanupId: ROOM, body: "mine", clientId: "c1" }),
    )
    const mineId = (aConn.framesOfType("ack").at(-1) as { message: ChatMessageDTO }).message.id
    await handleClientFrame(
      aSession,
      JSON.stringify({
        type: "send",
        cleanupId: ROOM,
        body: "self reply",
        clientId: "c2",
        replyToId: mineId,
      }),
    )
    await flush()

    expect(seams.replyBells).toHaveLength(0)
  })

  it("DEDUPE: reply target also @-mentioned -> reply bell only; the mention is still recorded; other mentions still bell", async () => {
    const seams = spySeams()
    const aConn = new MockConnection("A")
    const bConn = new MockConnection("B")
    const aSession = sessionFor(ALICE, aConn, seams)
    const bSession = sessionFor(BOB, bConn, seams)
    await handleClientFrame(bSession, JSON.stringify({ type: "join", cleanupId: ROOM }))
    await handleClientFrame(aSession, JSON.stringify({ type: "join", cleanupId: ROOM }))

    // Bob posts; Alice replies to Bob AND @mentions both bob and cara.
    await handleClientFrame(
      bSession,
      JSON.stringify({ type: "send", cleanupId: ROOM, body: "bob's message", clientId: "c1" }),
    )
    const bobMsgId = (bConn.framesOfType("ack").at(-1) as { message: ChatMessageDTO }).message.id
    await handleClientFrame(
      aSession,
      JSON.stringify({
        type: "send",
        cleanupId: ROOM,
        body: "hey @bob and @cara",
        clientId: "c2",
        replyToId: bobMsgId,
      }),
    )
    await flush()

    // The row and broadcast are NOT deduped; only the bell is.
    expect(seams.recorded).toHaveLength(1)
    expect(seams.recorded[0]!.ids.sort()).toEqual([BOB, CARA].sort())
    const ack = aConn.framesOfType("ack").at(-1) as { message: ChatMessageDTO }
    expect(ack.message.mentions.map((m) => m.id).sort()).toEqual([BOB, CARA].sort())

    // Bob gets ONLY the reply bell; Cara still gets her mention bell.
    expect(seams.replyBells).toEqual([
      { kind: "cleanup", roomId: ROOM, actorUserId: ALICE, targetUserId: BOB },
    ])
    expect(seams.mentionBells).toEqual([CARA])
  })

  it("a replyToId pointing nowhere -> room-stamped error frame with subcode reply_wrong_room, no ack", async () => {
    const seams = spySeams()
    const aConn = new MockConnection("A")
    const aSession = sessionFor(ALICE, aConn, seams)
    await handleClientFrame(aSession, JSON.stringify({ type: "join", cleanupId: ROOM }))

    await handleClientFrame(
      aSession,
      JSON.stringify({
        type: "send",
        cleanupId: ROOM,
        body: "ghost reply",
        clientId: "c9",
        replyToId: "99999999-9999-9999-9999-999999999999",
      }),
    )
    await flush()

    const err = aConn.framesOfType("error").at(-1)
    expect(err).toMatchObject({ code: "reply_wrong_room", cleanupId: ROOM })
    expect(aConn.framesOfType("ack")).toHaveLength(0)
    expect(seams.replyBells).toHaveLength(0)
  })
})
