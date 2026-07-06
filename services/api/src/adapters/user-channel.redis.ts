
import { UserSignalSchema, type UserSignal } from "@civfix/shared"
import type { ChatConnection, UserChannel } from "@civfix/shared/interfaces"
import type { FastifyBaseLogger } from "fastify"
import type { ChatPubSub } from "./chat-pubsub.js"

export function userChannel(userId: string): string {
  return `user:${userId}`
}

interface UserSubscription {
  connections: Set<ChatConnection>
  unsubscribe: () => Promise<void>
}

export interface RedisUserChannelDeps {
  pubsub: ChatPubSub
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

  async subscribeUser(userId: string, conn: ChatConnection): Promise<() => Promise<void>> {
    let entry = this.users.get(userId)
    if (!entry) {
      const connections = new Set<ChatConnection>()
      const newEntry: UserSubscription = { connections, unsubscribe: async () => {} }
      this.users.set(userId, newEntry)
      try {
        newEntry.unsubscribe = await this.pubsub.subscribe(userChannel(userId), (payload) => {
          const current = this.users.get(userId)
          if (!current) return
          const signal = decodeSignal(payload)
          if (signal === null) {
            this.logger?.warn({ userId }, "user-channel: dropped malformed signal payload")
            return
          }
          const frame = JSON.stringify({ type: "signal", ...signal })
          for (const c of current.connections) c.send(frame)
        })
      } catch (err) {
        this.users.delete(userId)
        throw err
      }
      entry = newEntry
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

  async publishToUser(userId: string, signal: UserSignal): Promise<void> {
    await this.pubsub.publish(userChannel(userId), JSON.stringify(signal))
  }

  async publishToUsers(userIds: readonly string[], signal: UserSignal): Promise<void> {
    const unique = [...new Set(userIds)]
    await Promise.all(unique.map((userId) => this.publishToUser(userId, signal)))
  }

  async close(): Promise<void> {
    const unsubs = [...this.users.values()].map((u) => u.unsubscribe())
    this.users.clear()
    await Promise.allSettled(unsubs)
  }

  subscriberCount(userId: string): number {
    return this.users.get(userId)?.connections.size ?? 0
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
