
import { attachRedisErrorHandler, type RedisClient } from "./redis.js"
import { RefCountedSubscriptions } from "./ref-counted-subscriptions.js"

export type ChatPubSubHandler = (payload: string) => void

export interface ChatPubSub {
  publish(channel: string, payload: string): Promise<void>
  subscribe(channel: string, handler: ChatPubSubHandler): Promise<() => Promise<void>>
  close(): Promise<void>
}

export function chatChannel(cleanupId: string): string {
  return `chat:${cleanupId}`
}

export class RedisChatPubSub implements ChatPubSub {
  private readonly pub: RedisClient
  private readonly sub: RedisClient
  private readonly subscriptions: RefCountedSubscriptions<ChatPubSubHandler>
  private wired = false

  constructor(redis: RedisClient, onError?: (err: Error) => void) {
    this.pub = redis
    this.sub = redis.duplicate()
    attachRedisErrorHandler(this.sub, onError)
    this.subscriptions = new RefCountedSubscriptions<ChatPubSubHandler>(async (channel) => {
      await this.sub.subscribe(channel)
      return async () => {
        await this.sub.unsubscribe(channel)
      }
    })
  }

  private ensureWired(): void {
    if (this.wired) return
    this.wired = true
    this.sub.on("message", (channel: string, message: string) => {
      const set = this.subscriptions.membersOf(channel)
      if (!set) return
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
    this.subscriptions.clear()
    this.sub.disconnect()
  }
}

export class InMemoryChatPubSub implements ChatPubSub {
  private readonly handlers = new Map<string, Set<ChatPubSubHandler>>()

  publish(channel: string, payload: string): Promise<void> {
    const set = this.handlers.get(channel)
    if (set) {
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

  get channelCount(): number {
    return this.handlers.size
  }
}
