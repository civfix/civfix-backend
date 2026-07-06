import { describe, it, expect, beforeEach } from "vitest"
import { RedisUserChannel, userChannel } from "../../src/adapters/user-channel.redis.js"
import { InMemoryChatPubSub, type ChatPubSub } from "../../src/adapters/chat-pubsub.js"
import { MockConnection } from "../helpers/chat.js"
import { WsServerMessageSchema } from "@civfix/shared"


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
    const worker1 = new RedisUserChannel({ pubsub })
    const worker2 = new RedisUserChannel({ pubsub })

    const aConn = new MockConnection("A")
    await worker1.subscribeUser(ALICE, aConn)
    expect(worker1.subscriberCount(ALICE)).toBe(1)

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
    expect(bConn.framesOfType("signal")).toHaveLength(0)
    await channel.close()
  })

  it("publishToUsers de-dupes and fans out to each unique user once", async () => {
    const channel = new RedisUserChannel({ pubsub })
    const aConn = new MockConnection("A")
    const bConn = new MockConnection("B")
    await channel.subscribeUser(ALICE, aConn)
    await channel.subscribeUser(BOB, bConn)

    await channel.publishToUsers([ALICE, BOB, ALICE], { topic: "notifications" })

    expect(aConn.framesOfType("signal")).toHaveLength(1)
    expect(bConn.framesOfType("signal")).toHaveLength(1)
    await channel.close()
  })

  it("drops a malformed pub/sub payload without throwing (subscriber survives)", async () => {
    const channel = new RedisUserChannel({ pubsub })
    const aConn = new MockConnection("A")
    await channel.subscribeUser(ALICE, aConn)

    await pubsub.publish(userChannel(ALICE), "not json{{{")
    await pubsub.publish(userChannel(ALICE), JSON.stringify({ topic: "bogus" }))
    await pubsub.publish(userChannel(ALICE), JSON.stringify({ topic: "notifications", evil: 1 }))

    expect(aConn.framesOfType("signal")).toHaveLength(0)

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

    await worker1.close()
    expect(worker1.subscriberCount(ALICE)).toBe(0)
    expect(pubsub.channelCount).toBe(1)

    await worker2.publishToUser(BOB, { topic: "notifications" })
    expect(bConn.framesOfType("signal")).toHaveLength(1)
    await worker2.close()
    expect(pubsub.channelCount).toBe(0)
  })

  it("deletes the phantom user entry when the first SUBSCRIBE rejects, so a retry can subscribe", async () => {
    let failNext = true
    const flaky: ChatPubSub = {
      publish: (c, p) => pubsub.publish(c, p),
      subscribe: async (c, h) => {
        if (failNext) {
          failNext = false
          throw new Error("redis blip")
        }
        return pubsub.subscribe(c, h)
      },
      close: () => pubsub.close(),
    }
    const channel = new RedisUserChannel({ pubsub: flaky })
    const aConn = new MockConnection("A")

    await expect(channel.subscribeUser(ALICE, aConn)).rejects.toThrow("redis blip")
    expect(channel.subscriberCount(ALICE)).toBe(0)

    await channel.subscribeUser(ALICE, aConn)
    await channel.publishToUser(ALICE, { topic: "notifications" })
    expect(aConn.framesOfType("signal")).toHaveLength(1)
    await channel.close()
  })

  it("close() resolves even when one unsubscribe rejects (allSettled), clearing all entries", async () => {
    const badChannel = userChannel(ALICE)
    const flaky: ChatPubSub = {
      publish: (c, p) => pubsub.publish(c, p),
      subscribe: async (c, h) => {
        const un = await pubsub.subscribe(c, h)
        if (c === badChannel) {
          return async () => {
            throw new Error("unsub failed")
          }
        }
        return un
      },
      close: () => pubsub.close(),
    }
    const channel = new RedisUserChannel({ pubsub: flaky })
    await channel.subscribeUser(ALICE, new MockConnection("A"))
    await channel.subscribeUser(BOB, new MockConnection("B"))

    await expect(channel.close()).resolves.toBeUndefined()
    expect(channel.subscriberCount(ALICE)).toBe(0)
    expect(channel.subscriberCount(BOB)).toBe(0)
  })

  it("unsubscribe on the last local conn drops the channel; an earlier conn keeps it", async () => {
    const channel = new RedisUserChannel({ pubsub })
    const a1 = new MockConnection("A1")
    const a2 = new MockConnection("A2")
    const dispose1 = await channel.subscribeUser(ALICE, a1)
    await channel.subscribeUser(ALICE, a2)
    expect(channel.subscriberCount(ALICE)).toBe(2)
    expect(pubsub.channelCount).toBe(1)

    await dispose1()
    expect(channel.subscriberCount(ALICE)).toBe(1)
    expect(pubsub.channelCount).toBe(1)
    await channel.publishToUser(ALICE, { topic: "notifications" })
    expect(a1.framesOfType("signal")).toHaveLength(0)
    expect(a2.framesOfType("signal")).toHaveLength(1)
    await channel.close()
  })
})
