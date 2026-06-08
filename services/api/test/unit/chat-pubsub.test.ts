import { describe, it, expect } from "vitest"
import { InMemoryChatPubSub, chatChannel } from "../../src/adapters/chat-pubsub.js"
import { WsChatService } from "../../src/adapters/chat-service.ws.js"
import { InMemoryChatRepository, MockConnection } from "../helpers/chat.js"
import type { ChatMessageDTO } from "@civfix/shared"

/**
 * Redis pub/sub fan-out, proven LOCALLY with an in-memory pub/sub standing in for Redis.
 *
 * The point of the pub/sub layer is cross-WORKER delivery: a WebSocket for cleanup R may live on Node
 * worker A while the sender's socket lives on worker B. We simulate two workers as two SEPARATE
 * WsChatService instances that share ONE InMemoryChatPubSub (the "Redis"). A message broadcast on
 * instance 1 must reach a connection joined on instance 2, exactly as a Redis PUBLISH on one node reaches
 * subscribers on another. The in-memory pub/sub exercises the identical publish/subscribe wiring with no
 * network, which is what makes the fan-out testable offline.
 */

const ROOM = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
const ALICE = "11111111-1111-1111-1111-111111111111"
const BOB = "22222222-2222-2222-2222-222222222222"

describe("Redis pub/sub fan-out across two workers (in-memory pub/sub)", () => {
  it("delivers a message broadcast on worker 1 to a connection joined on worker 2", async () => {
    // ONE shared pub/sub (the stand-in for Redis) bridges the two workers.
    const pubsub = new InMemoryChatPubSub()

    // Each "worker" has its own ChatService + its own persistence (mirrors separate processes). The
    // sender's worker persists; the recipient's worker only needs to receive the published frame.
    const repo1 = new InMemoryChatRepository()
    repo1.registerSender({ id: ALICE, displayName: "Alice" })
    const worker1 = new WsChatService({ repo: repo1, pubsub })

    const repo2 = new InMemoryChatRepository()
    const worker2 = new WsChatService({ repo: repo2, pubsub })

    // Bob's socket is on worker 2; he joins the room there.
    const bConn = new MockConnection("B-on-worker2")
    await worker2.joinRoom(ROOM, bConn, BOB)
    // The shared pub/sub now has a subscriber for the room channel.
    expect(pubsub.channelCount).toBe(1)

    // Alice sends from worker 1: persist there, then broadcast (PUBLISH) on the shared pub/sub.
    const msg = await worker1.persist({ cleanupId: ROOM, userId: ALICE, body: "cross-worker hi", clientId: "c1" })
    await worker1.broadcast(ROOM, msg)

    // Bob (worker 2) received the broadcast even though Alice's socket lives on a different worker.
    const frames = bConn.framesOfType("message")
    expect(frames).toHaveLength(1)
    expect((frames[0] as { message: ChatMessageDTO }).message.body).toBe("cross-worker hi")
    expect((frames[0] as { message: ChatMessageDTO }).message.from.id).toBe(ALICE)
  })

  it("publishes on the cleanup-scoped channel name", async () => {
    const pubsub = new InMemoryChatPubSub()
    const received: string[] = []
    await pubsub.subscribe(chatChannel(ROOM), (payload) => received.push(payload))

    const repo = new InMemoryChatRepository()
    const worker = new WsChatService({ repo, pubsub })
    const msg = await worker.persist({ cleanupId: ROOM, userId: ALICE, body: "hi", clientId: "c" })
    await worker.broadcast(ROOM, msg)

    expect(received).toHaveLength(1)
    // The internal pub/sub envelope wraps the client-facing frame under `frame` (+ optional
    // excludeConnId), so subscribers on any worker can deliver the schema-clean WsServerMessage.
    const envelope = JSON.parse(received[0]!) as {
      frame: { type: string; message: ChatMessageDTO }
    }
    expect(envelope.frame.type).toBe("message")
    expect(envelope.frame.message.body).toBe("hi")
  })

  it("a message on a DIFFERENT room channel is not delivered to this room's subscribers", async () => {
    const pubsub = new InMemoryChatPubSub()
    const repo = new InMemoryChatRepository()
    const worker = new WsChatService({ repo, pubsub })

    const conn = new MockConnection()
    await worker.joinRoom(ROOM, conn, BOB)

    // Broadcast to a different cleanup id; this room's connection must NOT receive it.
    const other = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
    const msg = await worker.persist({ cleanupId: other, userId: ALICE, body: "elsewhere", clientId: "c" })
    await worker.broadcast(other, msg)
    expect(conn.framesOfType("message")).toHaveLength(0)
  })

  it("unsubscribes the channel when the last local connection leaves", async () => {
    const pubsub = new InMemoryChatPubSub()
    const repo = new InMemoryChatRepository()
    const worker = new WsChatService({ repo, pubsub })

    const conn = new MockConnection()
    await worker.joinRoom(ROOM, conn, BOB)
    expect(pubsub.channelCount).toBe(1)
    await worker.leaveRoom(ROOM, conn)
    expect(pubsub.channelCount).toBe(0)
    expect(worker.roomSize(ROOM)).toBe(0)
  })
})
