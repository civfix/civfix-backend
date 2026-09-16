import type { FeedRankingConfig } from "@civfix/shared"
import type { RankedCandidate } from "./feed-ranking.js"

export interface FeedPresenceCache {
  get(key: string): Promise<string | null>
  set(key: string, value: string, ttlSeconds: number): Promise<void>
  sadd(key: string, ...members: string[]): Promise<number>
  smembers(key: string): Promise<string[]>
  scard(key: string): Promise<number>
  expire(key: string, ttlSeconds: number): Promise<void>
}

export interface FeedPresenceDeps {
  cache?: FeedPresenceCache
  config: FeedRankingConfig
  logger?: { warn(obj: unknown, msg?: string): void; debug?(obj: unknown, msg?: string): void }
}

export interface FeedSnapshotEntry {
  id: string
  score: number
}

export interface FeedPresence {
  readSnapshot(userId: string, filter: string): Promise<FeedSnapshotEntry[] | null>
  writeSnapshot(userId: string, filter: string, ranked: readonly RankedCandidate[]): Promise<void>
  seenBy(userId: string, postIds: readonly string[]): Promise<Set<string>>
  recordServed(userId: string, postIds: readonly string[]): Promise<void>
  viewersOf(postId: string): Promise<string[]>
}

export function snapshotKey(userId: string, filter: string): string {
  return `feed:rank:v1:${userId}:${filter}`
}

export function servedKey(userId: string): string {
  return `feed:served:v1:${userId}`
}

export function viewersKey(postId: string): string {
  return `feed:viewers:v1:${postId}`
}

function isSnapshotEntry(value: unknown): value is [string, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "string" &&
    typeof value[1] === "number" &&
    Number.isFinite(value[1])
  )
}

export function makeFeedPresence(deps: FeedPresenceDeps): FeedPresence {
  const cfg = deps.config

  async function guarded<T>(fallback: T, label: string, run: () => Promise<T>): Promise<T> {
    if (deps.cache === undefined) return fallback
    try {
      return await run()
    } catch (err) {
      deps.logger?.warn({ err }, `feed presence: ${label} failed (ignored)`)
      return fallback
    }
  }

  return {
    readSnapshot(userId: string, filter: string): Promise<FeedSnapshotEntry[] | null> {
      return guarded<FeedSnapshotEntry[] | null>(null, "snapshot read", async () => {
        const raw = await deps.cache!.get(snapshotKey(userId, filter))
        if (raw === null) return null
        const parsed: unknown = JSON.parse(raw)
        if (!Array.isArray(parsed)) return null
        const entries: FeedSnapshotEntry[] = []
        for (const value of parsed) {
          if (!isSnapshotEntry(value)) return null
          entries.push({ id: value[0], score: value[1] })
        }
        return entries
      })
    },

    writeSnapshot(
      userId: string,
      filter: string,
      ranked: readonly RankedCandidate[],
    ): Promise<void> {
      if (cfg.snapshotTtlSeconds <= 0) return Promise.resolve()
      return guarded<void>(undefined, "snapshot write", async () => {
        const payload = ranked
          .slice(0, cfg.candidateCap)
          .map((entry) => [entry.id, entry.score] as const)
        await deps.cache!.set(
          snapshotKey(userId, filter),
          JSON.stringify(payload),
          cfg.snapshotTtlSeconds,
        )
      })
    },

    seenBy(userId: string, postIds: readonly string[]): Promise<Set<string>> {
      if (postIds.length === 0) return Promise.resolve(new Set<string>())
      return guarded(new Set<string>(), "served-set read", async () => {
        const members = await deps.cache!.smembers(servedKey(userId))
        const served = new Set(members)
        return new Set(postIds.filter((id) => served.has(id)))
      })
    },

    recordServed(userId: string, postIds: readonly string[]): Promise<void> {
      if (postIds.length === 0) return Promise.resolve()
      const unique = [...new Set(postIds)]
      return guarded<void>(undefined, "served-set write", async () => {
        const cache = deps.cache!
        await cache.sadd(servedKey(userId), ...unique)
        await cache.expire(servedKey(userId), cfg.servedTtlSeconds)

        const sizes = await Promise.all(unique.map((postId) => cache.scard(viewersKey(postId))))
        const admitted = unique.filter((_, i) => (sizes[i] ?? 0) < cfg.viewerFanoutMax)
        await Promise.all(admitted.map((postId) => cache.sadd(viewersKey(postId), userId)))
        await Promise.all(
          admitted.map((postId) => cache.expire(viewersKey(postId), cfg.servedTtlSeconds)),
        )
      })
    },

    viewersOf(postId: string): Promise<string[]> {
      return guarded<string[]>([], "viewer index read", async () => {
        const cache = deps.cache!
        const key = viewersKey(postId)
        const size = await cache.scard(key)
        if (size === 0) return []
        if (size > cfg.viewerFanoutMax) {
          deps.logger?.debug?.(
            { postId, size, cap: cfg.viewerFanoutMax },
            "feed presence: viewer fanout skipped (over cap)",
          )
          return []
        }
        return cache.smembers(key)
      })
    },
  }
}
