import { UserSignalSchema, type UserSignal } from "@civfix/shared"
import type { ChatConnection, UserChannel } from "@civfix/shared/interfaces"
import type { FastifyBaseLogger } from "fastify"
import type { ChatPubSub } from "./chat-pubsub.js"
import { RefCountedSubscriptions } from "./ref-counted-subscriptions.js"

const USER_CHANNEL_PREFIX = "user:"

export function userChannel(userId: string): string {
  return `${USER_CHANNEL_PREFIX}${userId}`
}

export interface RedisUserChannelDeps {
  pubsub: ChatPubSub
  logger?: Pick<FastifyBaseLogger, "warn">
}

export class RedisUserChannel implements UserChannel {
  private readonly pubsub: ChatPubSub
  private readonly logger: Pick<FastifyBaseLogger, "warn"> | undefined
  /**
   * userId -> the user's local sockets, ref-counted: the first socket subscribes `user:<id>`, the last one
   * unsubscribes. A rejected first SUBSCRIBE removes the entry so a retry really re-subscribes (see
   * RefCountedSubscriptions).
   */
  private readonly subscriptions: RefCountedSubscriptions<ChatConnection>

  constructor(deps: RedisUserChannelDeps) {
    this.pubsub = deps.pubsub
    this.logger = deps.logger
    this.subscriptions = new RefCountedSubscriptions<ChatConnection>((userId, connections) =>
      this.pubsub.subscribe(userChannel(userId), (payload) => {
        const signal = decodeSignal(payload)
        if (signal === null) {
          this.logger?.warn({ userId }, "user-channel: dropped malformed signal payload")
          return
        }
        const frame = JSON.stringify({ type: "signal", ...signal })
        // Live set: a socket that disposed its subscription mid-delivery is already gone from it.
        for (const c of [...connections()]) c.send(frame)
      }),
    )
  }

  subscribeUser(userId: string, conn: ChatConnection): Promise<() => Promise<void>> {
    return this.subscriptions.add(userId, conn)
  }

  async publishToUser(userId: string, signal: UserSignal): Promise<void> {
    await this.pubsub.publish(userChannel(userId), JSON.stringify(signal))
  }

  async publishToUsers(userIds: readonly string[], signal: UserSignal): Promise<void> {
    const unique = [...new Set(userIds)]
    await Promise.all(unique.map((userId) => this.publishToUser(userId, signal)))
  }

  async close(): Promise<void> {
    // allSettled inside closeAll: one rejected unsubscribe must not leave the other entries behind.
    await this.subscriptions.closeAll()
  }

  subscriberCount(userId: string): number {
    return this.subscriptions.size(userId)
  }
}

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
