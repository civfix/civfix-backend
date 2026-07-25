/**
 * Chat pub/sub seam: a vendor-neutral fan-out channel so a chat message published on one Node worker
 * reaches connections held on ANOTHER worker.
 *
 * WHY a seam (not ioredis directly in the chat adapter): civfix runs more than one Node process behind
 * the load balancer, so a WebSocket for cleanup R may live on worker A while the sender's socket lives
 * on worker B. An in-process room map alone would never deliver A's message to B. Redis pub/sub bridges
 * them: every worker SUBSCRIBES to `chat:<cleanupId>` and PUBLISHES sends there; each worker then writes
 * the received frame to its own local sockets. Confining ioredis to RedisChatPubSub (and the
 * adapters/redis module) keeps the realtime SDK out of domain code AND lets tests swap an in-memory or
 * ioredis-mock pub/sub so the fan-out path is exercised locally with no Redis.
 *
 * ioredis note: a connection in "subscriber mode" cannot issue normal commands, so RedisChatPubSub uses
 * a DEDICATED duplicated connection for SUBSCRIBE and the shared client for PUBLISH.
 */

import type { RedisClient } from "./redis.js"
import { RefCountedSubscriptions } from "./ref-counted-subscriptions.js"

/** Handler invoked with the raw payload string delivered on a subscribed channel. */
export type ChatPubSubHandler = (payload: string) => void

/**
 * Minimal pub/sub abstraction. `subscribe` registers a handler for a channel and returns an async
 * unsubscribe. Multiple handlers may subscribe to the same channel (the impl multiplexes). `publish`
 * delivers a payload to every subscriber of the channel across all workers.
 */
export interface ChatPubSub {
  publish(channel: string, payload: string): Promise<void>
  subscribe(channel: string, handler: ChatPubSubHandler): Promise<() => Promise<void>>
  /** Tear down any underlying connections. Safe to call once at shutdown. */
  close(): Promise<void>
}

/** The Redis channel name for a cleanup's chat room. */
export function chatChannel(cleanupId: string): string {
  return `chat:${cleanupId}`
}

/**
 * Redis-backed pub/sub. Uses a single duplicated subscriber connection that demultiplexes "message"
 * events to the per-channel handler sets registered here; PUBLISH goes through the shared client.
 */
export class RedisChatPubSub implements ChatPubSub {
  private readonly pub: RedisClient
  private readonly sub: RedisClient
  /**
   * channel -> handlers registered on THIS worker, ref-counted: the first handler triggers the Redis
   * SUBSCRIBE, the last one triggers UNSUBSCRIBE. A rejected SUBSCRIBE removes the entry (see
   * RefCountedSubscriptions) — leaving an empty entry behind would make every retry skip the SUBSCRIBE and
   * attach handlers to a channel Redis never delivers.
   */
  private readonly subscriptions: RefCountedSubscriptions<ChatPubSubHandler>
  private wired = false

  /**
   * @param redis the shared ioredis client (used for PUBLISH). A duplicate is created for the
   *              subscriber connection, since a subscribed connection cannot run other commands.
   */
  constructor(redis: RedisClient) {
    this.pub = redis
    this.sub = redis.duplicate()
    this.subscriptions = new RefCountedSubscriptions<ChatPubSubHandler>(async (channel) => {
      await this.sub.subscribe(channel)
      // Last handler gone: UNSUBSCRIBE so Redis stops delivering this channel to this worker.
      return async () => {
        await this.sub.unsubscribe(channel)
      }
    })
  }

  /** Lazily attach the single message listener that routes to per-channel handlers. */
  private ensureWired(): void {
    if (this.wired) return
    this.wired = true
    this.sub.on("message", (channel: string, message: string) => {
      const set = this.subscriptions.membersOf(channel)
      if (!set) return
      // Copy so a handler that unsubscribes mid-iteration does not mutate the live set.
      for (const h of [...set]) h(message)
    })
  }

  publish(channel: string, payload: string): Promise<void> {
    return this.pub.publish(channel, payload).then(() => undefined)
  }

  subscribe(channel: string, handler: ChatPubSubHandler): Promise<() => Promise<void>> {
    this.ensureWired()
    return this.subscriptions.add(channel, handler)
  }

  async close(): Promise<void> {
    // No per-channel UNSUBSCRIBE: the subscriber connection itself is going away. Only the duplicated
    // subscriber connection is owned here; the shared `pub` is closed by the DI container's redis handle.
    // Disconnect the subscriber so the process can exit cleanly.
    this.subscriptions.clear()
    this.sub.disconnect()
  }
}

/**
 * In-memory pub/sub for tests (and the in-proc dev path). Delivers synchronously to handlers registered
 * in this process, which is exactly enough to prove the fan-out wiring: a message published to a channel
 * reaches every subscriber's handler. Use this (or ioredis-mock) so the chat fan-out is testable with no
 * Redis.
 */
export class InMemoryChatPubSub implements ChatPubSub {
  private readonly handlers = new Map<string, Set<ChatPubSubHandler>>()

  publish(channel: string, payload: string): Promise<void> {
    const set = this.handlers.get(channel)
    if (set) {
      // Copy so a handler that unsubscribes mid-iteration does not mutate the live set.
      for (const h of [...set]) h(payload)
    }
    return Promise.resolve()
  }

  subscribe(channel: string, handler: ChatPubSubHandler): Promise<() => Promise<void>> {
    let set = this.handlers.get(channel)
    if (!set) {
      set = new Set()
      this.handlers.set(channel, set)
    }
    set.add(handler)
    return Promise.resolve(() => {
      const current = this.handlers.get(channel)
      if (current) {
        current.delete(handler)
        if (current.size === 0) this.handlers.delete(channel)
      }
      return Promise.resolve()
    })
  }

  close(): Promise<void> {
    this.handlers.clear()
    return Promise.resolve()
  }

  /** Test helper: number of channels with at least one local subscriber. */
  get channelCount(): number {
    return this.handlers.size
  }
}
