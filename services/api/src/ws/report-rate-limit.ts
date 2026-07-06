
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

export function makeTokenBucketLimiter(opts: TokenBucketOptions): RateLimiter {
  const now = opts.now ?? (() => Date.now())
  const maxKeys = Math.max(1, opts.maxKeys ?? 50_000)
  const buckets = new Map<string, Bucket>()

  const evictToCap = (): void => {
    while (buckets.size > maxKeys) {
      const oldest = buckets.keys().next().value
      if (oldest === undefined) break
      buckets.delete(oldest)
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
