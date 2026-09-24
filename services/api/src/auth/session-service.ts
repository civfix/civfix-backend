import { AppError, type Role } from "@civfix/shared"
import { generateToken, sha256Hex } from "./crypto.js"
import type { CacheClient } from "./cache.js"
import { isOfficialAccount } from "./official-account.js"
import { assertTargetIsNotOperatorRole } from "./operator-target.js"
import type { AccountStatus, SessionStore } from "./stores.js"

export const DEFAULT_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60

export const ABSOLUTE_SESSION_MAX_SECONDS = 90 * 24 * 60 * 60

export const BANNED_MARKER_GRACE_SECONDS = 60

export const DEFAULT_SLIDE_GRANULARITY_MS = 60 * 60 * 1000

const SESSION_KEY_PREFIX = "sess:"

const BANNED_KEY_PREFIX = "banned:"

const EPOCH_KEY_PREFIX = "sessepoch:"

export interface ResolvedSession {
  userId: string
  roles: Role[]
  accountStatus: AccountStatus
}

export type SessionSource = "cache" | "store"

export interface ResolveResult extends ResolvedSession {
  source: SessionSource
  expiresAtMs?: number
}

export interface SessionMeta {
  userAgent?: string | null
  ip?: string | null
  accountStatus?: AccountStatus
}

export interface SessionLogger {
  error(obj: unknown, msg?: string): void
}

interface CachedSession {
  userId: string
  roles: Role[]
  expiresAtMs: number
  createdAtMs: number
  epoch: number
  accountStatus: AccountStatus
}

interface UserGate {
  active: boolean
  epoch: number
}

const REVOKED_STATUSES: ReadonlySet<AccountStatus> = new Set<AccountStatus>(["banned"])

export interface SessionUserLookup {
  accountStatus(id: string): Promise<AccountStatus>
  findById(id: string): Promise<{ role: Role } | null>
}

export interface SessionServiceOptions {
  store: SessionStore
  cache: CacheClient
  users?: SessionUserLookup
  ttlSeconds?: number
  absoluteMaxSeconds?: number
  slideGranularityMs?: number
  now?: () => number
  logger?: SessionLogger
}

function sessionKey(hash: string): string {
  return SESSION_KEY_PREFIX + hash
}

function bannedKey(userId: string): string {
  return BANNED_KEY_PREFIX + userId
}

function epochKey(userId: string): string {
  return EPOCH_KEY_PREFIX + userId
}

function parseEpoch(raw: string | null): number {
  if (raw === null) return 0
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : 0
}

export class SessionService {
  private readonly store: SessionStore
  private readonly cache: CacheClient
  private readonly users: SessionUserLookup | undefined
  private readonly ttlSeconds: number
  private readonly absoluteMaxSeconds: number
  private readonly slideGranularityMs: number
  private readonly now: () => number
  private readonly logger: SessionLogger | undefined

  constructor(opts: SessionServiceOptions) {
    this.store = opts.store
    this.cache = opts.cache
    this.users = opts.users
    this.ttlSeconds = opts.ttlSeconds ?? DEFAULT_SESSION_TTL_SECONDS
    this.absoluteMaxSeconds = opts.absoluteMaxSeconds ?? ABSOLUTE_SESSION_MAX_SECONDS
    this.slideGranularityMs = opts.slideGranularityMs ?? DEFAULT_SLIDE_GRANULARITY_MS
    this.now = opts.now ?? Date.now
    this.logger = opts.logger
  }

  async createSession(userId: string, roles: Role[], meta: SessionMeta = {}): Promise<string> {
    if (isOfficialAccount(userId)) {
      throw AppError.forbidden("This account cannot start a new session.")
    }
    const token = generateToken()
    const hash = await sha256Hex(token)
    const nowMs = this.now()
    const expiresAt = new Date(nowMs + this.ttlSeconds * 1000)
    const lastSeen = new Date(nowMs)

    const [epoch, mintStatus] = await Promise.all([
      this.currentEpoch(userId),
      this.users
        ? this.users.accountStatus(userId)
        : Promise.resolve(meta.accountStatus ?? "active"),
    ])
    if (mintStatus === "banned" || mintStatus === "suspended") {
      throw AppError.forbidden("This account cannot start a new session.")
    }
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
      {
        userId,
        roles: [...roles],
        expiresAtMs: expiresAt.getTime(),
        createdAtMs: nowMs,
        epoch,
        accountStatus: mintStatus,
      },
      nowMs,
    )
    return token
  }

  async resolveSession(token: string): Promise<ResolveResult | null> {
    return this.resolveSessionByHash(await sha256Hex(token))
  }

  async resolveSessionByHash(hash: string): Promise<ResolveResult | null> {
    const nowMs = this.now()

    const cachedRaw = await this.cache.get(sessionKey(hash))
    if (cachedRaw !== null) {
      const cached = this.parseCache(cachedRaw)
      if (cached && cached.expiresAtMs > nowMs && !REVOKED_STATUSES.has(cached.accountStatus)) {
        if (this.absolutelyExpired(cached.createdAtMs, nowMs)) {
          await this.expireSession(hash)
          return null
        }
        const gate = await this.userGate(cached.userId)
        if (!gate.active) return null
        if (cached.epoch === gate.epoch) {
          await this.maybeSlide(hash, cached.expiresAtMs, cached.createdAtMs, nowMs)
          return {
            userId: cached.userId,
            roles: cached.roles,
            accountStatus: cached.accountStatus,
            source: "cache",
            expiresAtMs: cached.expiresAtMs,
          }
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

    const gate = await this.userGate(row.userId)
    if (!gate.active) return null
    if (REVOKED_STATUSES.has(row.accountStatus)) {
      await this.enforceRevokedStatus(row.userId, hash)
      return null
    }

    await this.writeCache(
      hash,
      {
        userId: row.userId,
        roles: row.roles,
        expiresAtMs: row.expiresAt.getTime(),
        createdAtMs: row.createdAt.getTime(),
        epoch: gate.epoch,
        accountStatus: row.accountStatus,
      },
      nowMs,
    )
    await this.maybeSlide(hash, row.expiresAt.getTime(), row.createdAt.getTime(), nowMs)
    return {
      userId: row.userId,
      roles: row.roles,
      accountStatus: row.accountStatus,
      source: "store",
      expiresAtMs: row.expiresAt.getTime(),
    }
  }

  async revokeSession(token: string): Promise<void> {
    await this.revokeSessionByHash(await sha256Hex(token))
  }

  async revokeSessionByHash(hash: string): Promise<void> {
    await this.cache.del(sessionKey(hash))
    await this.store.deleteById(hash)
  }

  async revokeAllForUser(userId: string): Promise<number> {
    await this.bumpEpoch(userId)
    const ids = await this.store.deleteAllForUser(userId)
    await this.evictSessionCaches(ids, userId)
    return ids.length
  }

  async banUser(userId: string): Promise<number> {
    await this.cache.set(bannedKey(userId), "1", this.ttlSeconds + BANNED_MARKER_GRACE_SECONDS)
    await this.bumpEpoch(userId)
    const ids = await this.store.deleteAllForUser(userId)
    await this.evictSessionCaches(ids, userId)
    return ids.length
  }

  async applyAccountStatus(userId: string, status: AccountStatus): Promise<number> {
    if (status === "banned" || status === "suspended") {
      const target = await this.users?.findById(userId)
      assertTargetIsNotOperatorRole(target?.role, status === "banned" ? "ban" : "suspend")
    }
    if (status === "banned") return this.banUser(userId)
    await this.clearBan(userId)
    if (status === "suspended") return this.revokeAllForUser(userId)
    await this.bumpEpoch(userId)
    return 0
  }

  private async evictSessionCaches(hashes: string[], userId: string): Promise<void> {
    const results = await Promise.allSettled(hashes.map((hash) => this.cache.del(sessionKey(hash))))
    results.forEach((result, index) => {
      if (result.status === "rejected") {
        this.logger?.error(
          { userId, hash: hashes[index]!, err: result.reason },
          "session cache eviction failed during revoke",
        )
      }
    })
  }

  async clearBan(userId: string): Promise<void> {
    await this.cache.del(bannedKey(userId))
  }

  async isUserActive(userId: string): Promise<boolean> {
    const marked = await this.cache.get(bannedKey(userId))
    return marked === null
  }

  async currentEpoch(userId: string): Promise<number> {
    return parseEpoch(await this.cache.get(epochKey(userId)))
  }

  async bumpEpoch(userId: string): Promise<number> {
    return this.cache.incr(epochKey(userId), this.ttlSeconds + BANNED_MARKER_GRACE_SECONDS)
  }

  get ttl(): number {
    return this.ttlSeconds
  }

  private async userGate(userId: string): Promise<UserGate> {
    if (isOfficialAccount(userId)) return { active: false, epoch: 0 }
    const keys = [bannedKey(userId), epochKey(userId)]
    const [banned, epochRaw] = this.cache.mget
      ? await this.cache.mget(keys)
      : await Promise.all(keys.map((key) => this.cache.get(key)))
    return { active: (banned ?? null) === null, epoch: parseEpoch(epochRaw ?? null) }
  }

  private async enforceRevokedStatus(userId: string, hash: string): Promise<void> {
    await this.cache
      .set(bannedKey(userId), "1", this.ttlSeconds + BANNED_MARKER_GRACE_SECONDS)
      .catch((err: unknown) => {
        this.logger?.error({ userId, err }, "ban marker refresh failed during resolve")
      })
    await this.expireSession(hash)
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
    if (extendedMs - currentExpiryMs < this.slideGranularityMs) return
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
        typeof parsed.expiresAtMs === "number" &&
        typeof parsed.createdAtMs === "number" &&
        typeof parsed.epoch === "number" &&
        typeof parsed.accountStatus === "string"
      ) {
        return {
          userId: parsed.userId,
          roles: parsed.roles as Role[],
          expiresAtMs: parsed.expiresAtMs,
          createdAtMs: parsed.createdAtMs,
          epoch: parsed.epoch,
          accountStatus: parsed.accountStatus as AccountStatus,
        }
      }
      return null
    } catch {
      return null
    }
  }
}
