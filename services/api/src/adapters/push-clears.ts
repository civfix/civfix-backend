import type { PushClearTarget } from "@civfix/seams"
import type { RedisClient } from "./redis.js"

// D8: past this many ids a clear names none and removes every notifications-page push instead.
const PUSH_CLEAR_IDS_MAX = 100

// Notification ids are UUIDs, so this member can never collide with one.
const CLEAR_ALL_MEMBER = "*"

const PENDING_KEY_PREFIX = "push:clear:pending:"

// The flush job takes the set within seconds; the expiry only reaps a set whose job was lost.
const PENDING_TTL_SECONDS = 3600

export function pendingClearsKey(userId: string): string {
  return `${PENDING_KEY_PREFIX}${userId}`
}

/** The clears queued for each user until the user's flush job sends them as one push. */
export interface PendingClears {
  /** `target.ids` is never empty. */
  add(userId: string, target: PushClearTarget): Promise<void>
  /** Reads and removes everything queued for the user; null when nothing was. */
  take(userId: string): Promise<PushClearTarget | null>
}

function clearTargetOf(members: readonly string[]): PushClearTarget | null {
  if (members.length === 0) return null
  if (members.includes(CLEAR_ALL_MEMBER)) return { all: true }
  if (members.length > PUSH_CLEAR_IDS_MAX) return { all: true }
  return { ids: [...members] }
}

export class RedisPendingClears implements PendingClears {
  private readonly redis: () => RedisClient

  // A getter, so building the sender opens no socket.
  constructor(redis: () => RedisClient) {
    this.redis = redis
  }

  async add(userId: string, target: PushClearTarget): Promise<void> {
    const members = "all" in target ? [CLEAR_ALL_MEMBER] : target.ids
    const key = pendingClearsKey(userId)
    await this.redis()
      .multi()
      .sadd(key, ...members)
      .expire(key, PENDING_TTL_SECONDS)
      .exec()
  }

  async take(userId: string): Promise<PushClearTarget | null> {
    const key = pendingClearsKey(userId)
    // One transaction, so an id added while the job runs lands either in this read or in the next job.
    const results = await this.redis().multi().smembers(key).del(key).exec()
    const read = results?.[0]
    if (read === undefined) throw new Error("push clears: the read transaction did not run")
    const [err, members] = read
    if (err) throw err
    return clearTargetOf(members as string[])
  }
}
