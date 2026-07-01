
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
  const maxKeys = opts.maxKeys ?? 50_000
  const buckets = new Map<string, Bucket>()

  const prune = (t: number): void => {
    for (const [k, b] of buckets) {
      const refilled = Math.min(opts.capacity, b.tokens + ((t - b.last) / 1000) * opts.refillPerSec)
      if (refilled >= opts.capacity) buckets.delete(k)
    }
  }

  return {
    tryConsume(key: string): boolean {
      const t = now()
      const b = buckets.get(key) ?? { tokens: opts.capacity, last: t }
      b.tokens = Math.min(opts.capacity, b.tokens + ((t - b.last) / 1000) * opts.refillPerSec)
      b.last = t
      if (b.tokens < 1) {
        buckets.set(key, b)
        return false
      }
      b.tokens -= 1
      buckets.set(key, b)
      if (buckets.size > maxKeys) prune(t)
      return true
    },
  }
}
