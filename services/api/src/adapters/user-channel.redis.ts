/**
 * REAL UserChannel adapter: a per-USER realtime fan-out so a domain event for a user (a new notification,
 * a thread-unread bump) reaches every socket that user holds — on this worker AND on others — and is
 * turned into a tiny invalidate-signal frame the client maps to a query refetch.
 *
 * Seam rule: the Redis SDK is confined to the chat-pubsub / redis modules; this adapter talks only to the
 * injected ChatPubSub seam, so tests build it over an in-memory pub/sub (or ioredis-mock) and prove the
 * fan-out path with no Redis. UserChannel is a SEPARATE seam from ChatService (interface-segregation):
 * per-user events are a distinct concern from chat rooms, even though both ride the same generic pub/sub.
 *
 * PER-USER + FAN-OUT MODEL (mirrors WsChatService's room map, keyed by userId instead of cleanupId):
 *   - users: Map<userId, Set<ChatConnection>> holds the sockets this user has on THIS worker.
 *   - On the first local connection for a user, we SUBSCRIBE to user:<userId>. The subscription handler
 *     decodes the delivered payload, defensively validates it (UserSignalSchema), and writes the
 *     CLIENT-facing {type:"signal", ...signal} frame to every local connection for that user. On the last
 *     local connection's unsubscribe, we unsubscribe and drop the user.
 *   - publishToUser PUBLISHES the BARE UserSignal JSON to user:<userId>. Every worker subscribed to that
 *     channel (including this one) then delivers it to its own local sockets, so a recipient on worker A
 *     and the publisher on worker B converge on the same delivery path. Delivering ONLY via the
 *     subscription (not by writing local sockets directly in publish) keeps a single delivery path so
 *     local and cross-worker recipients are treated identically.
 *
 * BEST-EFFORT: publishToUser/publishToUsers are invoked off a domain write that has already committed, so
 * the channel is a freshness hint, never a correctness guarantee. The subscription handler NEVER throws
 * (a malformed payload is logged and dropped) so a stray publish cannot tear down the subscriber.
 *
 * CLOSE OWNERSHIP (shared pub/sub): in production this adapter and WsChatService share ONE
 * RedisChatPubSub instance (one duplicated subscriber connection multiplexes chat:* + user:*), wired in
 * di.ts. close() here ONLY unsubscribes this adapter's own user:* channels; it MUST NOT close the shared
 * pub/sub. chatService.close() owns pubsub.close() (it disconnects the dedicated subscriber connection).
 * Closing the pub/sub here too would double-close it.
 */

import { UserSignalSchema, type UserSignal } from "@civfix/shared"
import type { ChatConnection, UserChannel } from "@civfix/shared/interfaces"
import type { FastifyBaseLogger } from "fastify"
import type { ChatPubSub } from "./chat-pubsub.js"

/** The Redis channel name for a user's per-user signal stream. */
export function userChannel(userId: string): string {
  return `user:${userId}`
}

/** Per-user local state: the connected sockets on this worker + the pub/sub unsubscribe handle. */
interface UserSubscription {
  connections: Set<ChatConnection>
  unsubscribe: () => Promise<void>
}

export interface RedisUserChannelDeps {
  /** Fan-out seam. Redis in production (shared with WsChatService), in-memory / ioredis-mock in tests. */
  pubsub: ChatPubSub
  /** Logger for the dropped-malformed-payload path. Optional; defaults to no logging. */
  logger?: Pick<FastifyBaseLogger, "warn">
}

export class RedisUserChannel implements UserChannel {
  private readonly pubsub: ChatPubSub
  private readonly logger: Pick<FastifyBaseLogger, "warn"> | undefined
  private readonly users = new Map<string, UserSubscription>()

  constructor(deps: RedisUserChannelDeps) {
    this.pubsub = deps.pubsub
    this.logger = deps.logger
  }

  /**
   * Register a connection (held by userId) to receive this user's signal frames on this worker. On the
   * first connection for the user, subscribe to user:<userId>; the handler delivers every signal received
   * (local or cross-worker) to the user's local sockets. Returns an idempotent unsubscribe that removes
   * this connection and, when it was the user's last, unsubscribes from the channel.
   */
  async subscribeUser(userId: string, conn: ChatConnection): Promise<() => Promise<void>> {
    let entry = this.users.get(userId)
    if (!entry) {
      const connections = new Set<ChatConnection>()
      // Subscribe first so no published signal is missed once the user is present. The handler decodes
      // the bare UserSignal, validates it defensively, then writes the CLIENT-facing {type:"signal", ...}
      // frame to every local connection for this user.
      const unsubscribe = await this.pubsub.subscribe(userChannel(userId), (payload) => {
        const current = this.users.get(userId)
        if (!current) return
        const signal = decodeSignal(payload)
        if (signal === null) {
          // Drop (never throw inside the pub/sub handler) so one bad publish cannot tear down delivery.
          this.logger?.warn({ userId }, "user-channel: dropped malformed signal payload")
          return
        }
        const frame = JSON.stringify({ type: "signal", ...signal })
        for (const c of current.connections) c.send(frame)
      })
      entry = { connections, unsubscribe }
      this.users.set(userId, entry)
    }
    entry.connections.add(conn)

    let removed = false
    return async () => {
      if (removed) return
      removed = true
      const current = this.users.get(userId)
      if (!current) return
      current.connections.delete(conn)
      if (current.connections.size === 0) {
        this.users.delete(userId)
        await current.unsubscribe()
      }
    }
  }

  /**
   * Publish a signal to every live connection userId holds, across all workers. PUBLISHES the BARE
   * UserSignal JSON; delivery to sockets happens in the subscription handler (single delivery path).
   * Best-effort: this is called off an already-committed domain write.
   */
  async publishToUser(userId: string, signal: UserSignal): Promise<void> {
    await this.pubsub.publish(userChannel(userId), JSON.stringify(signal))
  }

  /**
   * Fan a signal to many users (e.g. all cleanup members on a new message). De-dupes the ids so a member
   * listed twice is signaled once, and awaits all publishes. Best-effort.
   */
  async publishToUsers(userIds: readonly string[], signal: UserSignal): Promise<void> {
    const unique = [...new Set(userIds)]
    await Promise.all(unique.map((userId) => this.publishToUser(userId, signal)))
  }

  /**
   * Tear down THIS adapter's per-user subscriptions. It does NOT close the shared pub/sub: in production
   * WsChatService owns pubsub.close() (the dedicated Redis subscriber connection). See the close-ownership
   * note in the file header — closing it here too would double-close the shared instance.
   */
  async close(): Promise<void> {
    const unsubs = [...this.users.values()].map((u) => u.unsubscribe())
    this.users.clear()
    await Promise.all(unsubs)
  }

  /** Test/diagnostic helper: number of local connections currently subscribed for a user. */
  subscriberCount(userId: string): number {
    return this.users.get(userId)?.connections.size ?? 0
  }
}

/**
 * Decode a published pub/sub payload into a validated UserSignal, or null when it is not a well-formed
 * signal (non-JSON, or fails the strict schema). Returning null (rather than throwing) lets the
 * subscription handler log+drop a bad payload without tearing down the subscriber.
 */
function decodeSignal(payload: string): UserSignal | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    return null
  }
  const result = UserSignalSchema.safeParse(parsed)
  return result.success ? result.data : null
}
