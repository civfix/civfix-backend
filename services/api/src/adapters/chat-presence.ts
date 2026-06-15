/**
 * Chat presence registry: WHO is currently online (connected) in each cleanup chat room.
 *
 * WHY a seam (not an in-process Set): civfix can run more than one Node worker behind the load balancer,
 * so a room's members may hold sockets on different workers. An in-process online set on each worker would
 * only ever know its OWN sockets, so the "N online" count would be wrong (a per-worker lower bound). Redis
 * is the shared source of truth: every worker records its sockets here and reads the union back. The
 * registry is also SELF-HEALING - each entry carries a last-seen timestamp refreshed by the socket
 * heartbeat (every WS_HEARTBEAT_MS), and stale entries (older than PRESENCE_TTL_MS) are pruned on every
 * read/write. So an ungraceful disconnect (worker crash, network drop with no close frame) can leave an
 * entry behind, but it expires within the TTL window rather than inflating the count forever.
 *
 * MODEL: one Redis sorted set per room, `presence:<cleanupId>`, whose MEMBERS are `<userId>::<connId>`
 * (one per live connection) and whose SCORE is the last-seen epoch-ms. A user is "online" if they have at
 * least one non-stale connection. Counting distinct userIds collapses a user's multiple devices/tabs to a
 * single presence. Membership authorization is enforced by the gateway BEFORE join() is called.
 *
 * The registry deals only in presence bookkeeping; the gateway decides what to BROADCAST (a presence delta
 * via ChatService.broadcastEvent, a snapshot to the joiner). Keeping it off the ChatService interface
 * means presence stays a gateway concern and the frozen ChatService seam is untouched.
 */

import type { RedisClient } from "./redis.js"

/** How long an entry survives without a heartbeat refresh before it is treated as gone (3x heartbeat). */
export const PRESENCE_TTL_MS = 90_000

/** Idle-room hygiene: expire the whole presence key after this long with no writes (Redis EXPIRE). */
const PRESENCE_KEY_TTL_SECONDS = 7200

/** Separator between userId and connId in a sorted-set member. UUIDs never contain "::", so it is safe. */
const SEP = "::"

/** Result of a join: the resulting online set + whether THIS user just transitioned offline->online. */
export interface PresenceJoinResult {
  /** De-duplicated, sorted list of currently-online member ids (one per online user). */
  online: string[]
  /** True only when this connection is the user's FIRST in the room (so a join delta should be sent). */
  userJoined: boolean
}

/** Result of a leave: the resulting online set + whether THIS user's LAST connection just left. */
export interface PresenceLeaveResult {
  online: string[]
  /** True only when the user has no remaining connections in the room (so a leave delta should be sent). */
  userGone: boolean
}

/**
 * Presence bookkeeping behind a vendor-neutral seam. Redis-backed in production; in-memory for the fake
 * dev path and tests. All methods are room-scoped and reference-counted by connection id.
 */
export interface ChatPresence {
  /** Record `connId` (held by `userId`) as present in the room. Idempotent per connId (updates last-seen). */
  join(cleanupId: string, connId: string, userId: string): Promise<PresenceJoinResult>
  /** Remove `connId` from the room. Idempotent (a connId not present is a no-op). */
  leave(cleanupId: string, connId: string, userId: string): Promise<PresenceLeaveResult>
  /** Refresh the last-seen of `connId` (called from the socket heartbeat) so it is not pruned. */
  refresh(cleanupId: string, connId: string, userId: string): Promise<void>
  /** The de-duplicated, sorted list of currently-online user ids in the room (stale entries pruned). */
  online(cleanupId: string): Promise<string[]>
  /** Tear down any owned resources (no-op for the Redis impl - it borrows the shared client). */
  close(): Promise<void>
}

/** Build the sorted-set member id for a connection. */
function member(userId: string, connId: string): string {
  return `${userId}${SEP}${connId}`
}

/** Extract the userId from a member id. */
function userOf(memberId: string): string {
  const idx = memberId.indexOf(SEP)
  return idx === -1 ? memberId : memberId.slice(0, idx)
}

/** Distinct, sorted user ids from a list of member ids. */
function distinctUsers(members: string[]): string[] {
  return [...new Set(members.map(userOf))].sort()
}

// ---------------------------------------------------------------------------
// Redis implementation
// ---------------------------------------------------------------------------

/**
 * Redis-backed presence. Uses standard sorted-set commands on the SHARED client (no dedicated connection
 * needed - unlike pub/sub, these are not subscriber-mode commands), so close() owns nothing. Every op
 * prunes entries older than PRESENCE_TTL_MS first, making the registry self-heal from ungraceful drops.
 */
export class RedisChatPresence implements ChatPresence {
  constructor(private readonly redis: RedisClient) {}

  private key(cleanupId: string): string {
    return `presence:${cleanupId}`
  }

  async join(cleanupId: string, connId: string, userId: string): Promise<PresenceJoinResult> {
    const key = this.key(cleanupId)
    const now = Date.now()
    // One MULTI instead of 4 serial round-trips (prune + zadd + expire + zrange): on a multi-worker
    // deployment Redis is a network hop, so collapsing the join path to a single RTT removes ~4x the
    // per-command latency from the connection-lifecycle path. MULTI also makes prune+write+read atomic,
    // so the membership snapshot we read back can't be perturbed by an interleaving command.
    const replies = await this.redis
      .multi()
      .zremrangebyscore(key, "-inf", `(${now - PRESENCE_TTL_MS}`)
      .zadd(key, now, member(userId, connId))
      .expire(key, PRESENCE_KEY_TTL_SECONDS)
      .zrange(key, 0, -1)
      .exec()
    // The zrange reply is the LAST command in the MULTI; reply is [err, value] per command.
    const members = (replies?.at(-1)?.[1] as string[]) ?? []
    // userJoined: this connection is the user's ONLY one in the room -> they just came online.
    const userConns = members.filter((m) => userOf(m) === userId).length
    return { online: distinctUsers(members), userJoined: userConns <= 1 }
  }

  async leave(cleanupId: string, connId: string, userId: string): Promise<PresenceLeaveResult> {
    const key = this.key(cleanupId)
    const now = Date.now()
    // One MULTI instead of 3 serial round-trips (zrem + prune + zrange) -> 1 RTT, atomic snapshot.
    const replies = await this.redis
      .multi()
      .zrem(key, member(userId, connId))
      .zremrangebyscore(key, "-inf", `(${now - PRESENCE_TTL_MS}`)
      .zrange(key, 0, -1)
      .exec()
    const members = (replies?.at(-1)?.[1] as string[]) ?? []
    const userGone = !members.some((m) => userOf(m) === userId)
    return { online: distinctUsers(members), userGone }
  }

  async refresh(cleanupId: string, connId: string, userId: string): Promise<void> {
    const key = this.key(cleanupId)
    // One MULTI instead of 2 serial round-trips (zadd + expire) -> 1 RTT.
    await this.redis
      .multi()
      .zadd(key, Date.now(), member(userId, connId))
      .expire(key, PRESENCE_KEY_TTL_SECONDS)
      .exec()
  }

  async online(cleanupId: string): Promise<string[]> {
    const key = this.key(cleanupId)
    const now = Date.now()
    // One MULTI instead of 2 serial round-trips (prune + zrange) -> 1 RTT, atomic snapshot.
    const replies = await this.redis
      .multi()
      .zremrangebyscore(key, "-inf", `(${now - PRESENCE_TTL_MS}`)
      .zrange(key, 0, -1)
      .exec()
    const members = (replies?.at(-1)?.[1] as string[]) ?? []
    return distinctUsers(members)
  }

  close(): Promise<void> {
    // The Redis presence ops run on the SHARED client (closed by the DI container); nothing owned here.
    return Promise.resolve()
  }
}

// ---------------------------------------------------------------------------
// In-memory implementation (fake dev path + tests)
// ---------------------------------------------------------------------------

/**
 * In-process presence with the SAME TTL/prune semantics as the Redis impl, so the fake dev path renders
 * presence and the gateway logic is unit-testable with no Redis. The clock is injectable so prune/TTL
 * behavior is deterministic in tests.
 */
export class InMemoryChatPresence implements ChatPresence {
  /** cleanupId -> (member -> last-seen epoch ms). */
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
    room.delete(member(userId, connId))
    this.prune(room, now)
    const members = [...room.keys()]
    const userGone = !members.some((m) => userOf(m) === userId)
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
