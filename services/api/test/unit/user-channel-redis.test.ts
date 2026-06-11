import { describe, it, expect, beforeEach } from "vitest"
import { RedisUserChannel, userChannel } from "../../src/adapters/user-channel.redis.js"
import { InMemoryChatPubSub } from "../../src/adapters/chat-pubsub.js"
import { MockConnection } from "../helpers/chat.js"
import { WsServerMessageSchema } from "@civfix/shared"

/**
 * The REAL RedisUserChannel over the in-memory ChatPubSub (the same fan-out wiring as Redis, minus the
 * network), proving:
 *   - CROSS-WORKER fan-out: two RedisUserChannel instances sharing ONE InMemoryChatPubSub — subscribe a
 *     user on instance 1, publishToUser from instance 2 — instance-1's local conn receives the
 *     {type:"signal"} frame (the recipient's worker got it via the shared pub/sub);
 *   - per-user channel naming + isolation (a different user's channel is untouched);
 *   - a MALFORMED pub/sub payload is dropped without throwing (the subscriber survives);
 *   - close() unsubscribes this instance's channels without closing the shared pub/sub.
 */

const ALICE = "11111111-1111-1111-1111-111111111111"
const BOB = "22222222-2222-2222-2222-222222222222"

let pubsub: InMemoryChatPubSub

beforeEach(() => {
  pubsub = new InMemoryChatPubSub()
})

function assertServerFrame(raw: string): void {
  const parsed = WsServerMessageSchema.safeParse(JSON.parse(raw))
  expect(parsed.success, `frame failed server schema: ${raw}`).toBe(true)
}

describe("RedisUserChannel over a shared in-memory pub/sub", () => {
  it("userChannel(userId) namespaces the channel as user:<id>", () => {
    expect(userChannel(ALICE)).toBe(`user:${ALICE}`)
  })

  it("fans a signal across two instances sharing one pub/sub (cross-worker)", async () => {
    // Two "workers" multiplexing the same pub/sub bus.
    const worker1 = new RedisUserChannel({ pubsub })
    const worker2 = new RedisUserChannel({ pubsub })

    // Alice's socket is held by worker 1.
    const aConn = new MockConnection("A")
    await worker1.subscribeUser(ALICE, aConn)
    expect(worker1.subscriberCount(ALICE)).toBe(1)

    // Worker 2 publishes for Alice (e.g. a notification created on another node).
    await worker2.publishToUser(ALICE, { topic: "notifications" })

    const signals = aConn.framesOfType("signal")
    expect(signals).toHaveLength(1)
    expect(signals[0]).toMatchObject({ type: "signal", topic: "notifications" })
    for (const raw of aConn.sent) assertServerFrame(raw)

    await worker1.close()
    await worker2.close()
  })

  it("delivers a scoped signal (with an id) and isolates per user", async () => {
    const channel = new RedisUserChannel({ pubsub })
    const aConn = new MockConnection("A")
    const bConn = new MockConnection("B")
    await channel.subscribeUser(ALICE, aConn)
    await channel.subscribeUser(BOB, bConn)

    await channel.publishToUser(ALICE, { topic: "threads", id: "cccccccc-cccc-cccc-cccc-cccccccccccc" })

    expect(aConn.framesOfType("signal")).toHaveLength(1)
    expect(aConn.framesOfType("signal")[0]).toMatchObject({
      type: "signal",
      topic: "threads",
      id: "cccccccc-cccc-cccc-cccc-cccccccccccc",
    })
    // Bob (a different user) got nothing.
    expect(bConn.framesOfType("signal")).toHaveLength(0)
    await channel.close()
  })

  it("publishToUsers de-dupes and fans out to each unique user once", async () => {
    const channel = new RedisUserChannel({ pubsub })
    const aConn = new MockConnection("A")
    const bConn = new MockConnection("B")
    await channel.subscribeUser(ALICE, aConn)
    await channel.subscribeUser(BOB, bConn)

    // Alice listed twice -> she is signaled exactly once.
    await channel.publishToUsers([ALICE, BOB, ALICE], { topic: "notifications" })

    expect(aConn.framesOfType("signal")).toHaveLength(1)
    expect(bConn.framesOfType("signal")).toHaveLength(1)
    await channel.close()
  })

  it("drops a malformed pub/sub payload without throwing (subscriber survives)", async () => {
    const channel = new RedisUserChannel({ pubsub })
    const aConn = new MockConnection("A")
    await channel.subscribeUser(ALICE, aConn)

    // A non-JSON payload published directly onto Alice's channel must be dropped, not delivered, and must
    // not tear down the subscriber.
    await pubsub.publish(userChannel(ALICE), "not json{{{")
    // A JSON payload that fails the strict schema (unknown topic) is also dropped.
    await pubsub.publish(userChannel(ALICE), JSON.stringify({ topic: "bogus" }))
    // An extra/unknown key fails the .strict() schema and is dropped too.
    await pubsub.publish(userChannel(ALICE), JSON.stringify({ topic: "notifications", evil: 1 }))

    expect(aConn.framesOfType("signal")).toHaveLength(0)

    // A subsequent WELL-FORMED publish still gets through (the subscriber survived the bad payloads).
    await channel.publishToUser(ALICE, { topic: "notifications" })
    expect(aConn.framesOfType("signal")).toHaveLength(1)
    await channel.close()
  })

  it("close() unsubscribes its own channels without closing the shared pub/sub", async () => {
    const worker1 = new RedisUserChannel({ pubsub })
    const worker2 = new RedisUserChannel({ pubsub })
    const aConn = new MockConnection("A")
    const bConn = new MockConnection("B")
    await worker1.subscribeUser(ALICE, aConn)
    await worker2.subscribeUser(BOB, bConn)
    expect(pubsub.channelCount).toBe(2)

    // Closing worker 1 drops ONLY its channel; worker 2's subscription (and the shared bus) survive.
    await worker1.close()
    expect(worker1.subscriberCount(ALICE)).toBe(0)
    expect(pubsub.channelCount).toBe(1)

    // Worker 2 still delivers.
    await worker2.publishToUser(BOB, { topic: "notifications" })
    expect(bConn.framesOfType("signal")).toHaveLength(1)
    await worker2.close()
    expect(pubsub.channelCount).toBe(0)
  })

  it("unsubscribe on the last local conn drops the channel; an earlier conn keeps it", async () => {
    const channel = new RedisUserChannel({ pubsub })
    const a1 = new MockConnection("A1")
    const a2 = new MockConnection("A2")
    const dispose1 = await channel.subscribeUser(ALICE, a1)
    await channel.subscribeUser(ALICE, a2)
    expect(channel.subscriberCount(ALICE)).toBe(2)
    expect(pubsub.channelCount).toBe(1)

    // Dropping one connection keeps the channel subscribed (a2 remains).
    await dispose1()
    expect(channel.subscriberCount(ALICE)).toBe(1)
    expect(pubsub.channelCount).toBe(1)
    await channel.publishToUser(ALICE, { topic: "notifications" })
    expect(a1.framesOfType("signal")).toHaveLength(0)
    expect(a2.framesOfType("signal")).toHaveLength(1)
    await channel.close()
  })
})
