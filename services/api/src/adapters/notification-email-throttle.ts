/**
 * D10's two limits on notification email, kept in Redis so every API worker shares them: one email per
 * person per conversation per hour (a `SET NX` key with a one-hour TTL), and at most
 * NOTIFICATION_EMAILS_PER_HOUR per person (a counter whose window starts with its first email). A claim
 * that loses to the conversation key never touches the counter, and a claim refused by the counter gives
 * its conversation key back, so only emails that go out use up either limit; a send that fails gives
 * back both.
 */

import type { RedisClient } from "./redis.js"
import { attachAtomicDecrBy } from "./redis-incr.js"
import { MS_PER_SECOND, SECONDS_PER_HOUR } from "../lib/time.js"

export const NOTIFICATION_EMAILS_PER_HOUR = 20

const WINDOW_SECONDS = SECONDS_PER_HOUR

const KEY_PREFIX = "notifemail"

export interface EmailThrottleRequest {
  userId: string
  /** The conversation's link for a chat-category email; null when only the hourly cap applies. */
  conversation: string | null
}

export interface NotificationEmailThrottle {
  /** One answer per request, in order: true when the email may go out. */
  claim(requests: readonly EmailThrottleRequest[]): Promise<boolean[]>
  /** Gives back the claims of emails that were not sent. */
  release(requests: readonly EmailThrottleRequest[]): Promise<void>
}

function conversationKey(userId: string, conversation: string): string {
  return `${KEY_PREFIX}:conv:${userId}:${conversation}`
}

function capKey(userId: string): string {
  return `${KEY_PREFIX}:cap:${userId}`
}

type ExecReplies = [error: Error | null, result: unknown][] | null

function repliesOf(replies: ExecReplies): unknown[] {
  if (replies === null) throw new Error("notification email throttle: MULTI aborted")
  return replies.map(([err, result]) => {
    if (err) throw err
    return result
  })
}

/** A claim's commands run as MULTI, so each of its round trips is atomic as well as pipelined. */
export class RedisNotificationEmailThrottle implements NotificationEmailThrottle {
  // A getter, so building the notification service opens no socket.
  constructor(private readonly redis: () => RedisClient) {}

  async claim(requests: readonly EmailThrottleRequest[]): Promise<boolean[]> {
    const granted = requests.map(() => true)
    const chats = requests.flatMap((r, i) => (r.conversation !== null ? [i] : []))
    if (chats.length > 0) {
      const tx = this.redis().multi()
      for (const i of chats) {
        const r = requests[i]!
        tx.set(conversationKey(r.userId, r.conversation!), "1", "EX", WINDOW_SECONDS, "NX")
      }
      repliesOf(await tx.exec()).forEach((reply, n) => {
        if (reply !== "OK") granted[chats[n]!] = false
      })
    }

    const counted = requests.flatMap((_, i) => (granted[i] ? [i] : []))
    if (counted.length === 0) return granted
    const tx = this.redis().multi()
    for (const i of counted) {
      const key = capKey(requests[i]!.userId)
      // The SET opens the window with its TTL; INCR keeps it.
      tx.set(key, "0", "EX", WINDOW_SECONDS, "NX").incr(key)
    }
    const replies = repliesOf(await tx.exec())
    const refused: EmailThrottleRequest[] = []
    counted.forEach((i, n) => {
      if (Number(replies[n * 2 + 1]) <= NOTIFICATION_EMAILS_PER_HOUR) return
      granted[i] = false
      if (requests[i]!.conversation !== null) refused.push(requests[i]!)
    })
    if (refused.length > 0) {
      const giveBack = this.redis().multi()
      for (const r of refused) giveBack.del(conversationKey(r.userId, r.conversation!))
      repliesOf(await giveBack.exec())
    }
    return granted
  }

  async release(requests: readonly EmailThrottleRequest[]): Promise<void> {
    if (requests.length === 0) return
    const redis = this.redis()
    // Floored and never creating a key: a give-back that lands after the window closed opens no new one.
    const decrement = attachAtomicDecrBy(redis)
    await Promise.all(
      requests.map(async (r) => {
        await decrement(capKey(r.userId), 1)
        if (r.conversation !== null) await redis.del(conversationKey(r.userId, r.conversation))
      }),
    )
  }
}

/** The same limits in one process, for tests and for a deployment without Redis. */
export class InMemoryNotificationEmailThrottle implements NotificationEmailThrottle {
  private readonly conversations = new Map<string, number>()
  private readonly caps = new Map<string, { count: number; expiresAtMs: number }>()

  constructor(private readonly clock: () => number = () => Date.now()) {}

  claim(requests: readonly EmailThrottleRequest[]): Promise<boolean[]> {
    const now = this.clock()
    return Promise.resolve(
      requests.map((r) => {
        const conv = r.conversation !== null ? conversationKey(r.userId, r.conversation) : null
        if (conv !== null && (this.conversations.get(conv) ?? 0) > now) return false
        const cap = this.liveCap(r.userId, now)
        if (cap.count >= NOTIFICATION_EMAILS_PER_HOUR) return false
        cap.count += 1
        if (conv !== null) this.conversations.set(conv, now + WINDOW_SECONDS * MS_PER_SECOND)
        return true
      }),
    )
  }

  release(requests: readonly EmailThrottleRequest[]): Promise<void> {
    const now = this.clock()
    for (const r of requests) {
      const cap = this.caps.get(capKey(r.userId))
      if (cap && cap.expiresAtMs > now) cap.count = Math.max(0, cap.count - 1)
      if (r.conversation !== null)
        this.conversations.delete(conversationKey(r.userId, r.conversation))
    }
    return Promise.resolve()
  }

  private liveCap(userId: string, now: number): { count: number; expiresAtMs: number } {
    const key = capKey(userId)
    const existing = this.caps.get(key)
    if (existing && existing.expiresAtMs > now) return existing
    const fresh = { count: 0, expiresAtMs: now + WINDOW_SECONDS * MS_PER_SECOND }
    this.caps.set(key, fresh)
    return fresh
  }
}
