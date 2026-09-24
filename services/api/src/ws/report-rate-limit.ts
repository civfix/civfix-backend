export interface RateLimiter {
  tryConsume(key: string): boolean
}

export interface TokenBucketOptions {
  capacity: number
  refillPerSec: number
  now?: () => number
  maxKeys?: number
}

interface Bucket {
  tokens: number
  last: number
}

const EVICT_PREFER_FULL_WINDOW = 32

const DEFAULT_MAX_KEYS = 50_000

const MS_PER_SECOND = 1000

function refilledTokens(bucket: Bucket, at: number, opts: TokenBucketOptions): number {
  return Math.min(
    opts.capacity,
    bucket.tokens + ((at - bucket.last) / MS_PER_SECOND) * opts.refillPerSec,
  )
}

export function makeTokenBucketLimiter(opts: TokenBucketOptions): RateLimiter {
  const now = opts.now ?? (() => Date.now())
  const maxKeys = Math.max(1, opts.maxKeys ?? DEFAULT_MAX_KEYS)
  const buckets = new Map<string, Bucket>()

  const evictToCap = (): void => {
    while (buckets.size > maxKeys) {
      const t = now()
      let victim: string | undefined
      let scanned = 0
      for (const [k, b] of buckets) {
        if (scanned >= EVICT_PREFER_FULL_WINDOW) break
        scanned += 1
        if (refilledTokens(b, t, opts) >= opts.capacity) {
          victim = k
          break
        }
      }
      if (victim === undefined) victim = buckets.keys().next().value
      if (victim === undefined) break
      buckets.delete(victim)
    }
  }

  return {
    tryConsume(key: string): boolean {
      const t = now()
      const existing = buckets.get(key)
      const b = existing ?? { tokens: opts.capacity, last: t }
      if (existing) buckets.delete(key)
      b.tokens = refilledTokens(b, t, opts)
      b.last = t
      const allowed = b.tokens >= 1
      if (allowed) b.tokens -= 1
      buckets.set(key, b)
      evictToCap()
      return allowed
    },
  }
}
