import type { UserChannel } from "../interfaces/user-channel.js"
import type { ChatConnection } from "../interfaces/chat-service.js"
import type { UserSignal } from "@civfix/contract"

export interface CapturedSignal {
  userId: string
  signal: UserSignal
}

/**
 * In-process UserChannel. Subscriptions are a Map of userId -> Set<ChatConnection>; publishToUser calls
 * conn.send with the schema-clean `{type:"signal",...}` wire frame for every live connection that user
 * holds, and captures each publish for assertions.
 */
export class FakeUserChannel implements UserChannel {
  private readonly subscribers = new Map<string, Set<ChatConnection>>()
  readonly published: CapturedSignal[] = []

  subscribeUser(userId: string, conn: ChatConnection): Promise<() => Promise<void>> {
    let conns = this.subscribers.get(userId)
    if (!conns) {
      conns = new Set()
      this.subscribers.set(userId, conns)
    }
    conns.add(conn)
    return Promise.resolve(() => {
      this.subscribers.get(userId)?.delete(conn)
      return Promise.resolve()
    })
  }

  publishToUser(userId: string, signal: UserSignal): Promise<void> {
    this.published.push({ userId, signal })
    const conns = this.subscribers.get(userId)
    if (conns) {
      const frame = JSON.stringify({ type: "signal", ...signal })
      for (const conn of conns) conn.send(frame)
    }
    return Promise.resolve()
  }

  async publishToUsers(userIds: readonly string[], signal: UserSignal): Promise<void> {
    for (const userId of userIds) await this.publishToUser(userId, signal)
  }

  close(): Promise<void> {
    this.subscribers.clear()
    return Promise.resolve()
  }

  /** Test helper: number of connections currently subscribed for a user. */
  subscriberCount(userId: string): number {
    return this.subscribers.get(userId)?.size ?? 0
  }

  reset(): void {
    this.subscribers.clear()
    this.published.length = 0
  }
}
