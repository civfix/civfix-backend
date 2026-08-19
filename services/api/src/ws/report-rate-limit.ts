
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

export function makeTokenBucketLimiter(opts: TokenBucketOptions): RateLimiter {
  const now = opts.now ?? (() => Date.now())
  const maxKeys = Math.max(1, opts.maxKeys ?? 50_000)
  const buckets = new Map<string, Bucket>()

  const evictToCap = (): void => {
    while (buckets.size > maxKeys) {
      const t = now()
      let victim: string | undefined
      let scanned = 0
      for (const [k, b] of buckets) {
        if (scanned >= EVICT_PREFER_FULL_WINDOW) break
        scanned += 1
        const refilled = Math.min(opts.capacity, b.tokens + ((t - b.last) / 1000) * opts.refillPerSec)
        if (refilled >= opts.capacity) {
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
      b.tokens = Math.min(opts.capacity, b.tokens + ((t - b.last) / 1000) * opts.refillPerSec)
      b.last = t
      const allowed = b.tokens >= 1
      if (allowed) b.tokens -= 1
      buckets.set(key, b)
      evictToCap()
      return allowed
    },
  }
}
