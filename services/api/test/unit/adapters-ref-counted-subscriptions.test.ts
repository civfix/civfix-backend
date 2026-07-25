/**
 * Tests for the shared ref-counted subscription registry (src/adapters/ref-counted-subscriptions.ts) and
 * the RedisChatPubSub bug it exists to prevent.
 *
 * THE BUG: subscribe() inserted an EMPTY handler set into the channel map and THEN awaited the Redis
 * SUBSCRIBE. When that rejected (a Redis blip; maxRetriesPerRequest is 2), the empty set stayed behind, so
 * every later join saw a live-looking entry, SKIPPED the SUBSCRIBE, and attached handlers to a channel
 * Redis never delivers — permanent, silent message loss for that room on that worker, surviving every retry.
 *
 * The registry now (a) shares ONE in-flight subscribe between concurrent first-adders so neither leaks a
 * teardown handle, and (b) deletes the entry when that subscribe rejects so the next add really re-opens.
 */

import { describe, it, expect, vi } from "vitest"
import { EventEmitter } from "node:events"
import { RefCountedSubscriptions } from "../../src/adapters/ref-counted-subscriptions.js"
import { RedisChatPubSub, chatChannel } from "../../src/adapters/chat-pubsub.js"
import type { RedisClient } from "../../src/adapters/redis.js"

describe("RefCountedSubscriptions", () => {
  it("opens the upstream subscription ONCE for the first member and closes it on the last release", async () => {
    const opened: string[] = []
    const closed: string[] = []
    const subs = new RefCountedSubscriptions<string>((key) => {
      opened.push(key)
      return Promise.resolve(async () => {
        closed.push(key)
      })
    })

    const releaseA = await subs.add("room", "a")
    const releaseB = await subs.add("room", "b")
    expect(opened).toEqual(["room"])
    expect(subs.size("room")).toBe(2)
    expect(subs.keyCount).toBe(1)

    await releaseA()
    expect(closed).toEqual([])
    expect(subs.size("room")).toBe(1)

    await releaseB()
    expect(closed).toEqual(["room"])
    expect(subs.size("room")).toBe(0)
    expect(subs.keyCount).toBe(0)
  })

  it("shares ONE in-flight open between concurrent first-adds (no leaked teardown handle)", async () => {
    let openCount = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const closed: string[] = []
    const subs = new RefCountedSubscriptions<string>(async (key) => {
      openCount++
      await gate
      return async () => {
        closed.push(key)
      }
    })

    const both = Promise.all([subs.add("room", "a"), subs.add("room", "b")])
    release()
    const [releaseA, releaseB] = await both

    expect(openCount).toBe(1)
    expect(subs.size("room")).toBe(2)
    await releaseA()
    await releaseB()
    // Exactly ONE teardown existed to call.
    expect(closed).toEqual(["room"])
  })

  it("DELETES the entry when the open rejects, so the next add really re-opens", async () => {
    let failNext = true
    const opened: string[] = []
    const subs = new RefCountedSubscriptions<string>((key) => {
      if (failNext) {
        failNext = false
        return Promise.reject(new Error("upstream blip"))
      }
      opened.push(key)
      return Promise.resolve(async () => {})
    })

    await expect(subs.add("room", "a")).rejects.toThrow("upstream blip")
    // No phantom entry: the failed add left NOTHING behind.
    expect(subs.size("room")).toBe(0)
    expect(subs.keyCount).toBe(0)
    expect(subs.membersOf("room")).toBeUndefined()

    await subs.add("room", "a")
    expect(opened).toEqual(["room"])
    expect(subs.size("room")).toBe(1)
  })

  it("propagates a rejected open to EVERY concurrent adder (none believes it subscribed)", async () => {
    let openCount = 0
    const subs = new RefCountedSubscriptions<string>(async () => {
      openCount++
      await Promise.resolve()
      throw new Error("upstream blip")
    })

    const results = await Promise.allSettled([subs.add("room", "a"), subs.add("room", "b")])
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"])
    expect(openCount).toBe(1)
    expect(subs.size("room")).toBe(0)
  })

  it("release is idempotent and does not tear down twice", async () => {
    let closeCount = 0
    const subs = new RefCountedSubscriptions<string>(() =>
      Promise.resolve(async () => {
        closeCount++
      }),
    )
    const release = await subs.add("room", "a")
    await release()
    await release()
    await release()
    expect(closeCount).toBe(1)
  })

  it("remove(key, member) tears down on the last member and is a no-op for unknown keys", async () => {
    let closeCount = 0
    const subs = new RefCountedSubscriptions<string>(() =>
      Promise.resolve(async () => {
        closeCount++
      }),
    )
    await subs.add("room", "a")
    await subs.add("room", "b")

    await subs.remove("room", "b")
    expect(closeCount).toBe(0)
    await subs.remove("room", "a")
    expect(closeCount).toBe(1)

    await expect(subs.remove("room", "a")).resolves.toBeUndefined()
    await expect(subs.remove("nope", "a")).resolves.toBeUndefined()
  })

  it("exposes the LIVE member set to the open callback", async () => {
    let live: (() => ReadonlySet<string>) | undefined
    const subs = new RefCountedSubscriptions<string>((_key, members) => {
      live = members
      return Promise.resolve(async () => {})
    })
    await subs.add("room", "a")
    expect([...live!()]).toEqual(["a"])
    await subs.add("room", "b")
    expect([...live!()]).toEqual(["a", "b"])
    await subs.remove("room", "a")
    expect([...live!()]).toEqual(["b"])
  })

  it("closeAll tears down every key even when one teardown rejects, and drops all entries", async () => {
    const closed: string[] = []
    const subs = new RefCountedSubscriptions<string>((key) =>
      Promise.resolve(async () => {
        if (key === "bad") throw new Error("unsub failed")
        closed.push(key)
      }),
    )
    await subs.add("bad", "a")
    await subs.add("good", "b")

    await expect(subs.closeAll()).resolves.toBeUndefined()
    expect(closed).toEqual(["good"])
    expect(subs.keyCount).toBe(0)
    expect(subs.size("bad")).toBe(0)
  })

  it("clear() drops entries WITHOUT calling the upstream teardowns", async () => {
    let closeCount = 0
    const subs = new RefCountedSubscriptions<string>(() =>
      Promise.resolve(async () => {
        closeCount++
      }),
    )
    await subs.add("room", "a")
    subs.clear()
    expect(subs.keyCount).toBe(0)
    expect(closeCount).toBe(0)
  })
})

/** Minimal ioredis stand-in: only what RedisChatPubSub touches, with a scriptable SUBSCRIBE failure. */
class FakeRedis extends EventEmitter {
  subscribed = new Set<string>()
  subscribeCalls: string[] = []
  failNextSubscribe = false
  disconnected = false
  duplicated: FakeRedis[] = []

  duplicate(): FakeRedis {
    const dup = new FakeRedis()
    this.duplicated.push(dup)
    return dup
  }

  subscribe(channel: string): Promise<number> {
    this.subscribeCalls.push(channel)
    if (this.failNextSubscribe) {
      this.failNextSubscribe = false
      return Promise.reject(new Error("Stream isn't writeable"))
    }
    this.subscribed.add(channel)
    return Promise.resolve(this.subscribed.size)
  }

  unsubscribe(channel: string): Promise<number> {
    this.subscribed.delete(channel)
    return Promise.resolve(this.subscribed.size)
  }

  publish(channel: string, payload: string): Promise<number> {
    // Deliver only to the duplicated subscriber connections that actually SUBSCRIBEd.
    let n = 0
    for (const dup of this.duplicated) {
      if (dup.subscribed.has(channel)) {
        n++
        dup.emit("message", channel, payload)
      }
    }
    return Promise.resolve(n)
  }

  disconnect(): void {
    this.disconnected = true
  }
}

describe("RedisChatPubSub subscribe failure (the stranded-channel bug)", () => {
  it("a rejected SUBSCRIBE does not strand the channel: the retry re-SUBSCRIBEs and delivers", async () => {
    const redis = new FakeRedis()
    const pubsub = new RedisChatPubSub(redis as unknown as RedisClient)
    const sub = redis.duplicated[0]!
    const channel = chatChannel("room-1")

    sub.failNextSubscribe = true
    const handler = vi.fn()
    await expect(pubsub.subscribe(channel, handler)).rejects.toThrow("Stream isn't writeable")

    // The retry must issue a REAL Redis SUBSCRIBE (this is what the stale empty handler set used to skip).
    const unsubscribe = await pubsub.subscribe(channel, handler)
    expect(sub.subscribeCalls).toEqual([channel, channel])
    expect(sub.subscribed.has(channel)).toBe(true)

    await pubsub.publish(channel, "hello")
    expect(handler).toHaveBeenCalledWith("hello")

    await unsubscribe()
    expect(sub.subscribed.has(channel)).toBe(false)
    await pubsub.close()
    expect(sub.disconnected).toBe(true)
  })

  it("close() disconnects the duplicated subscriber without per-channel UNSUBSCRIBE chatter", async () => {
    const redis = new FakeRedis()
    const pubsub = new RedisChatPubSub(redis as unknown as RedisClient)
    const sub = redis.duplicated[0]!
    const handler = vi.fn()
    await pubsub.subscribe(chatChannel("a"), handler)
    await pubsub.subscribe(chatChannel("b"), () => {})

    await pubsub.close()
    expect(sub.disconnected).toBe(true)
    // A frame arriving after close reaches nobody: the local handler registry was cleared.
    await pubsub.publish(chatChannel("a"), "x")
    expect(handler).not.toHaveBeenCalled()
  })
})
