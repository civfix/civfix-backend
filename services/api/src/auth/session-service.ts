
import { AppError, type Role } from "@civfix/shared"
import { generateToken, sha256Hex } from "./crypto.js"
import type { CacheClient } from "./cache.js"
import type { SessionStore } from "./stores.js"

export const DEFAULT_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60

export const ABSOLUTE_SESSION_MAX_SECONDS = 90 * 24 * 60 * 60

export const BANNED_MARKER_GRACE_SECONDS = 60

const SESSION_KEY_PREFIX = "sess:"

const BANNED_KEY_PREFIX = "banned:"

export interface ResolvedSession {
  userId: string
  roles: Role[]
}

export type SessionSource = "cache" | "store"

export interface ResolveResult extends ResolvedSession {
  source: SessionSource
  expiresAtMs?: number
}

export interface SessionMeta {
  userAgent?: string | null
  ip?: string | null
}

export interface SessionLogger {
  error(obj: unknown, msg?: string): void
}

interface CachedSession {
  userId: string
  roles: Role[]
  expiresAtMs: number
  createdAtMs?: number
}

export interface SessionServiceOptions {
  store: SessionStore
  cache: CacheClient
  ttlSeconds?: number
  absoluteMaxSeconds?: number
  now?: () => number
  logger?: SessionLogger
}

function sessionKey(hash: string): string {
  return SESSION_KEY_PREFIX + hash
}

function bannedKey(userId: string): string {
  return BANNED_KEY_PREFIX + userId
}

export class SessionService {
  private readonly store: SessionStore
  private readonly cache: CacheClient
  private readonly ttlSeconds: number
  private readonly absoluteMaxSeconds: number
  private readonly now: () => number
  private readonly logger: SessionLogger | undefined

  constructor(opts: SessionServiceOptions) {
    this.store = opts.store
    this.cache = opts.cache
    this.ttlSeconds = opts.ttlSeconds ?? DEFAULT_SESSION_TTL_SECONDS
    this.absoluteMaxSeconds = opts.absoluteMaxSeconds ?? ABSOLUTE_SESSION_MAX_SECONDS
    this.now = opts.now ?? Date.now
    this.logger = opts.logger
  }

  async createSession(userId: string, roles: Role[], meta: SessionMeta = {}): Promise<string> {
    const token = generateToken()
    const hash = await sha256Hex(token)
    const nowMs = this.now()
    const expiresAt = new Date(nowMs + this.ttlSeconds * 1000)
    const lastSeen = new Date(nowMs)

    await this.store.insert({
      id: hash,
      userId,
      roles: [...roles],
      expiresAt,
      lastSeenAt: lastSeen,
      userAgent: meta.userAgent ?? null,
      ip: meta.ip ?? null,
    })

    await this.writeCache(
      hash,
      { userId, roles: [...roles], expiresAtMs: expiresAt.getTime(), createdAtMs: nowMs },
      nowMs,
    )
    return token
  }

  async resolveSession(token: string): Promise<ResolveResult | null> {
    const hash = await sha256Hex(token)
    const nowMs = this.now()

    const cachedRaw = await this.cache.get(sessionKey(hash))
    if (cachedRaw !== null) {
      const cached = this.parseCache(cachedRaw)
      if (cached && cached.createdAtMs !== undefined && cached.expiresAtMs > nowMs) {
        if (this.absolutelyExpired(cached.createdAtMs, nowMs)) {
          await this.expireSession(hash)
          return null
        }
        if (!(await this.isUserActive(cached.userId))) return null
        await this.maybeSlide(hash, cached.expiresAtMs, cached.createdAtMs, nowMs)
        return {
          userId: cached.userId,
          roles: cached.roles,
          source: "cache",
          expiresAtMs: cached.expiresAtMs,
        }
      }
      await this.cache.del(sessionKey(hash)).catch(() => {})
    }

    const row = await this.store.findById(hash)
    if (!row) return null
    if (
      row.expiresAt.getTime() <= nowMs ||
      this.absolutelyExpired(row.createdAt.getTime(), nowMs)
    ) {
      await this.expireSession(hash)
      return null
    }

    if (!(await this.isUserActive(row.userId))) return null

    await this.writeCache(
      hash,
      {
        userId: row.userId,
        roles: row.roles,
        expiresAtMs: row.expiresAt.getTime(),
        createdAtMs: row.createdAt.getTime(),
      },
      nowMs,
    )
    await this.maybeSlide(hash, row.expiresAt.getTime(), row.createdAt.getTime(), nowMs)
    return {
      userId: row.userId,
      roles: row.roles,
      source: "store",
      expiresAtMs: row.expiresAt.getTime(),
    }
  }

  async revokeSession(token: string): Promise<void> {
    const hash = await sha256Hex(token)
    await this.cache.del(sessionKey(hash))
    await this.store.deleteById(hash)
  }

  async revokeAllForUser(userId: string): Promise<number> {
    const ids = await this.store.deleteAllForUser(userId)
    const failed = await this.evictSessionCaches(ids, userId)
    if (failed.length > 0) {
      throw AppError.internal("Session cache eviction failed during revoke.")
    }
    return ids.length
  }

  async banUser(userId: string): Promise<number> {
    const ids = await this.store.deleteAllForUser(userId)
    await this.evictSessionCaches(ids, userId)
    await this.cache.set(bannedKey(userId), "1", this.ttlSeconds + BANNED_MARKER_GRACE_SECONDS)
    return ids.length
  }

  private async evictSessionCaches(hashes: string[], userId: string): Promise<string[]> {
    const results = await Promise.allSettled(hashes.map((hash) => this.cache.del(sessionKey(hash))))
    const failed: string[] = []
    results.forEach((result, index) => {
      if (result.status === "rejected") {
        const hash = hashes[index]!
        failed.push(hash)
        this.logger?.error(
          { userId, hash, err: result.reason },
          "session cache eviction failed during revoke",
        )
      }
    })
    return failed
  }

  async clearBan(userId: string): Promise<void> {
    await this.cache.del(bannedKey(userId))
  }

  async isUserActive(userId: string): Promise<boolean> {
    const marked = await this.cache.get(bannedKey(userId))
    return marked === null
  }

  get ttl(): number {
    return this.ttlSeconds
  }

  private absolutelyExpired(createdAtMs: number, nowMs: number): boolean {
    return nowMs >= createdAtMs + this.absoluteMaxSeconds * 1000
  }

  private async expireSession(hash: string): Promise<void> {
    await this.store.deleteById(hash)
    await this.cache.del(sessionKey(hash)).catch(() => {})
  }

  private async maybeSlide(
    hash: string,
    currentExpiryMs: number,
    createdAtMs: number,
    nowMs: number,
  ): Promise<void> {
    const remainingMs = currentExpiryMs - nowMs
    const halfWindowMs = (this.ttlSeconds * 1000) / 2
    if (remainingMs >= halfWindowMs) return

    const ceilingMs = createdAtMs + this.absoluteMaxSeconds * 1000
    const extendedMs = Math.min(nowMs + this.ttlSeconds * 1000, ceilingMs)
    if (extendedMs <= currentExpiryMs) return
    const newExpiresAt = new Date(extendedMs)
    await this.store.updateExpiry(hash, newExpiresAt, new Date(nowMs))

    const raw = await this.cache.get(sessionKey(hash))
    const cached = raw ? this.parseCache(raw) : null
    if (cached) {
      await this.writeCache(hash, { ...cached, expiresAtMs: newExpiresAt.getTime() }, nowMs)
    }
  }

  private async writeCache(hash: string, value: CachedSession, nowMs: number): Promise<void> {
    const ttl = Math.max(1, Math.ceil((value.expiresAtMs - nowMs) / 1000))
    await this.cache.set(sessionKey(hash), JSON.stringify(value), ttl)
  }

  private parseCache(raw: string): CachedSession | null {
    try {
      const parsed = JSON.parse(raw) as Partial<CachedSession>
      if (
        typeof parsed.userId === "string" &&
        Array.isArray(parsed.roles) &&
        typeof parsed.expiresAtMs === "number"
      ) {
        return {
          userId: parsed.userId,
          roles: parsed.roles as Role[],
          expiresAtMs: parsed.expiresAtMs,
          ...(typeof parsed.createdAtMs === "number" ? { createdAtMs: parsed.createdAtMs } : {}),
        }
      }
      return null
    } catch {
      return null
    }
  }
}
