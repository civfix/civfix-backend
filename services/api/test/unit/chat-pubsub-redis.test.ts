import { describe, it, expect, afterEach } from "vitest"
import RedisMock from "ioredis-mock"
import { RedisChatPubSub, chatChannel } from "../../src/adapters/chat-pubsub.js"
import { WsChatService } from "../../src/adapters/chat-service.ws.js"
import type { RedisClient } from "../../src/adapters/redis.js"
import { InMemoryChatRepository, MockConnection } from "../helpers/chat.js"
import type { ChatMessageDTO } from "@civfix/shared"

/**
 * Exercises the REAL RedisChatPubSub (the production ioredis pub/sub adapter) against ioredis-mock, so
 * the actual SUBSCRIBE/PUBLISH/duplicate() code path - not just the in-memory fake - is covered locally.
 * ioredis-mock shares published messages across connections derived from the same instance, mirroring a
 * real Redis closely enough to prove the adapter's wiring (duplicate() subscriber connection, per-channel
 * handler demux, unsubscribe on last handler).
 */

const ROOM = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
const ALICE = "11111111-1111-1111-1111-111111111111"
const BOB = "22222222-2222-2222-2222-222222222222"

// ioredis-mock is structurally an ioredis client; cast through unknown at this adapter-test boundary.
function makeMockRedis(): RedisClient {
  return new RedisMock() as unknown as RedisClient
}

const created: Array<{ close: () => Promise<void>; redis: RedisClient }> = []

afterEach(async () => {
  for (const c of created) {
    await c.close()
    c.redis.disconnect()
  }
  created.length = 0
})

describe("RedisChatPubSub over ioredis-mock", () => {
  it("delivers a published message frame to a subscriber via the real adapter", async () => {
    const redis = makeMockRedis()
    const pubsub = new RedisChatPubSub(redis)
    created.push({ close: () => pubsub.close(), redis })

    const received: string[] = []
    const unsubscribe = await pubsub.subscribe(chatChannel(ROOM), (p) => received.push(p))

    await pubsub.publish(
      chatChannel(ROOM),
      JSON.stringify({ type: "message", message: { body: "hi" } }),
    )
    // Allow the mock's async message delivery to flush.
    await new Promise((r) => setTimeout(r, 20))

    expect(received).toHaveLength(1)
    expect(JSON.parse(received[0]!).message.body).toBe("hi")

    await unsubscribe()
    await pubsub.publish(chatChannel(ROOM), "ignored")
    await new Promise((r) => setTimeout(r, 20))
    expect(received).toHaveLength(1)
  })

  it("fans a message out across two WsChatService workers sharing the ioredis-mock channel", async () => {
    // ioredis-mock delivers across connections duplicated from the same root instance, so we duplicate
    // the root for each worker's pub/sub to emulate two nodes on one Redis.
    const root = makeMockRedis()

    const redis1 = root.duplicate() as unknown as RedisClient
    const pubsub1 = new RedisChatPubSub(redis1)
    const repo1 = new InMemoryChatRepository()
    repo1.registerSender({ id: ALICE, displayName: "Alice" })
    const worker1 = new WsChatService({ repo: repo1, pubsub: pubsub1 })

    const redis2 = root.duplicate() as unknown as RedisClient
    const pubsub2 = new RedisChatPubSub(redis2)
    const repo2 = new InMemoryChatRepository()
    const worker2 = new WsChatService({ repo: repo2, pubsub: pubsub2 })

    created.push({ close: () => worker1.close(), redis: redis1 })
    created.push({ close: () => worker2.close(), redis: redis2 })
    created.push({ close: () => Promise.resolve(), redis: root })

    const bConn = new MockConnection("B")
    await worker2.joinRoom(ROOM, bConn, BOB)
    // Give the subscribe a tick to register on the mock.
    await new Promise((r) => setTimeout(r, 20))

    const msg = await worker1.persist({
      cleanupId: ROOM,
      userId: ALICE,
      body: "cross-node",
      clientId: "c1",
    })
    await worker1.broadcast(ROOM, msg)
    await new Promise((r) => setTimeout(r, 20))

    const frames = bConn.framesOfType("message")
    expect(frames).toHaveLength(1)
    expect((frames[0] as { message: ChatMessageDTO }).message.body).toBe("cross-node")
  })
})
