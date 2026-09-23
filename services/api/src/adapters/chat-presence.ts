/**
 * Chat presence lives in Redis rather than an in-process Set because a room's members may hold sockets on
 * different API workers; a per-worker set would undercount. Entries carry a last-seen timestamp refreshed
 * by the socket heartbeat and stale ones are pruned on every read/write, so an ungraceful disconnect
 * expires within PRESENCE_TTL_MS instead of inflating the count forever.
 *
 * Model: one sorted set per room, `presence:<cleanupId>`, members `<userId>::<connId>` (one per live
 * connection), score = last-seen epoch ms. Counting distinct userIds collapses a user's devices/tabs into
 * one presence. Membership authorization is enforced by the gateway BEFORE join() is called.
 *
 * Presence stays off the ChatService interface so it remains a gateway concern and that seam is untouched.
 */

import type { RedisClient } from "./redis.js"

/** 3x the socket heartbeat, so one or two missed beats do not drop a live connection. */
export const PRESENCE_TTL_MS = 90_000

const PRESENCE_KEY_TTL_SECONDS = 7200

const PRESENCE_KEY_PREFIX = "presence:"

/** UUIDs never contain "::", so splitting on the first occurrence is unambiguous. */
const SEP = "::"

export interface PresenceJoinResult {
  online: string[]
  /** True only when this connection is the user's FIRST in the room (so a join delta should be sent). */
  userJoined: boolean
}

export interface PresenceLeaveResult {
  online: string[]
  /**
   * True only when this call actually REMOVED a live entry for the connection AND the user has no
   * remaining connections in the room (so a leave delta should be sent).
   *
   * Security: the "actually removed" half matters. Deriving `userGone` from absence alone made it TRUE
   * for a room the caller was never present in, so a forged `leave` frame for a stranger's room broadcast
   * a presence event for the attacker to every member. It also means a connection already pruned by the
   * TTL sweep announces nothing; its absence was already reflected in every later snapshot.
   */
  userGone: boolean
}

/** Reference-counted by connection id, so a user with several sockets stays online until the last closes. */
export interface ChatPresence {
  join(cleanupId: string, connId: string, userId: string): Promise<PresenceJoinResult>
  leave(cleanupId: string, connId: string, userId: string): Promise<PresenceLeaveResult>
  refresh(cleanupId: string, connId: string, userId: string): Promise<void>
  online(cleanupId: string): Promise<string[]>
  close(): Promise<void>
}

function member(userId: string, connId: string): string {
  return `${userId}${SEP}${connId}`
}

function userOf(memberId: string): string {
  const idx = memberId.indexOf(SEP)
  return idx === -1 ? memberId : memberId.slice(0, idx)
}

// ZREMRANGEBYSCORE max bound: the "(" makes it exclusive, so an entry seen exactly at the cutoff survives
// as it does in the in-memory prune.
function staleScoreBound(now: number): string {
  return `(${now - PRESENCE_TTL_MS}`
}

function distinctUsers(members: string[]): string[] {
  return [...new Set(members.map(userOf))].sort()
}

type MultiReplies = [error: Error | null, result: unknown][] | null

/**
 * ioredis returns null only when the whole MULTI aborted, and otherwise one `[err, value]` slot per
 * command WITHOUT rolling back on a per-command runtime error. The snapshot drives the online count and
 * join/leave deltas, so any error slot is a hard failure rather than a silently incomplete member set.
 */
function presenceMembers(replies: MultiReplies): string[] {
  if (replies === null) throw new Error("presence MULTI aborted")
  for (const [err] of replies) {
    if (err) throw err
  }
  return (replies.at(-1)?.[1] as string[]) ?? []
}

/**
 * Callers validate the replies with presenceMembers first, so a non-numeric slot can only be a client that
 * returns the count as a string. Anything unparseable becomes 0 ("removed nothing"), the safe answer for
 * the userGone decision.
 */
function removedCount(replies: MultiReplies, index: number): number {
  const raw = replies?.[index]?.[1]
  const n = Number(raw)
  return Number.isFinite(n) ? n : 0
}

/**
 * Sorted-set commands are not subscriber-mode commands, so this runs on the SHARED client and close()
 * owns nothing.
 */
export class RedisChatPresence implements ChatPresence {
  constructor(private readonly redis: RedisClient) {}

  private key(cleanupId: string): string {
    return `${PRESENCE_KEY_PREFIX}${cleanupId}`
  }

  async join(cleanupId: string, connId: string, userId: string): Promise<PresenceJoinResult> {
    const key = this.key(cleanupId)
    const now = Date.now()
    // One MULTI instead of 4 serial round-trips, and prune+write+read become atomic so the snapshot
    // cannot be perturbed by an interleaving command.
    const replies = await this.redis
      .multi()
      .zremrangebyscore(key, "-inf", staleScoreBound(now))
      .zadd(key, now, member(userId, connId))
      .expire(key, PRESENCE_KEY_TTL_SECONDS)
      .zrange(key, 0, -1)
      .exec()
    const members = presenceMembers(replies)
    // presenceMembers verified the zadd applied, so === 1 is exact; an impossible 0 cannot be masked into
    // a spurious join delta.
    const userConns = members.filter((m) => userOf(m) === userId).length
    return { online: distinctUsers(members), userJoined: userConns === 1 }
  }

  async leave(cleanupId: string, connId: string, userId: string): Promise<PresenceLeaveResult> {
    const key = this.key(cleanupId)
    const now = Date.now()
    const replies = await this.redis
      .multi()
      .zrem(key, member(userId, connId))
      .zremrangebyscore(key, "-inf", staleScoreBound(now))
      .zrange(key, 0, -1)
      .exec()
    const members = presenceMembers(replies)
    // The ZREM's own reply slot decides whether this connection was really present; without it a `leave`
    // for a room the caller never joined broadcast a forged presence delta (see PresenceLeaveResult).
    const removed = removedCount(replies, 0) > 0
    const userGone = removed && !members.some((m) => userOf(m) === userId)
    return { online: distinctUsers(members), userGone }
  }

  async refresh(cleanupId: string, connId: string, userId: string): Promise<void> {
    const key = this.key(cleanupId)
    const replies = await this.redis
      .multi()
      .zadd(key, Date.now(), member(userId, connId))
      .expire(key, PRESENCE_KEY_TTL_SECONDS)
      .exec()
    presenceMembers(replies)
  }

  async online(cleanupId: string): Promise<string[]> {
    const key = this.key(cleanupId)
    const now = Date.now()
    const replies = await this.redis
      .multi()
      .zremrangebyscore(key, "-inf", staleScoreBound(now))
      .zrange(key, 0, -1)
      .exec()
    return distinctUsers(presenceMembers(replies))
  }

  close(): Promise<void> {
    return Promise.resolve()
  }
}

/** Same TTL/prune semantics as the Redis impl, so the gateway logic is unit-testable with no Redis. */
export class InMemoryChatPresence implements ChatPresence {
  private readonly rooms = new Map<string, Map<string, number>>()
  private readonly now: () => number

  constructor(now: () => number = () => Date.now()) {
    this.now = now
  }

  private prune(room: Map<string, number>, now: number): void {
    for (const [m, seen] of room) {
      if (seen < now - PRESENCE_TTL_MS) room.delete(m)
    }
  }

  private roomFor(cleanupId: string): Map<string, number> {
    let room = this.rooms.get(cleanupId)
    if (!room) {
      room = new Map()
      this.rooms.set(cleanupId, room)
    }
    return room
  }

  join(cleanupId: string, connId: string, userId: string): Promise<PresenceJoinResult> {
    const now = this.now()
    const room = this.roomFor(cleanupId)
    this.prune(room, now)
    room.set(member(userId, connId), now)
    const members = [...room.keys()]
    const userConns = members.filter((m) => userOf(m) === userId).length
    return Promise.resolve({ online: distinctUsers(members), userJoined: userConns <= 1 })
  }

  leave(cleanupId: string, connId: string, userId: string): Promise<PresenceLeaveResult> {
    const now = this.now()
    const room = this.roomFor(cleanupId)
    // Map.delete's boolean plays the ZREM count's role: only a connection that was really present may
    // announce a leave.
    const removed = room.delete(member(userId, connId))
    this.prune(room, now)
    const members = [...room.keys()]
    const userGone = removed && !members.some((m) => userOf(m) === userId)
    if (members.length === 0) this.rooms.delete(cleanupId)
    return Promise.resolve({ online: distinctUsers(members), userGone })
  }

  refresh(cleanupId: string, connId: string, userId: string): Promise<void> {
    const room = this.roomFor(cleanupId)
    room.set(member(userId, connId), this.now())
    return Promise.resolve()
  }

  online(cleanupId: string): Promise<string[]> {
    const room = this.rooms.get(cleanupId)
    if (!room) return Promise.resolve([])
    this.prune(room, this.now())
    return Promise.resolve(distinctUsers([...room.keys()]))
  }

  close(): Promise<void> {
    this.rooms.clear()
    return Promise.resolve()
  }
}
