import type { RedisClient } from "./redis.js"

// The window starts whenever the key has no expiry, not when the value equals the increment: a zero
// increment would otherwise restart it, and a key whose TTL was lost would never expire again.
const INCRBY_EXPIRE_LUA =
  "local n = redis.call('INCRBY', KEYS[1], ARGV[1]); if redis.call('PTTL', KEYS[1]) < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[2]) end; return n"

const INCRBY_COMMAND_NAME = "civfixIncrByWindow"

// DECRBY keeps the key's TTL, and a missing key is left missing so a late give-back cannot create a
// counter with no expiry.
const DECRBY_FLOOR_LUA =
  "local n = tonumber(redis.call('GET', KEYS[1]) or '0'); if n <= 0 then return 0 end; return redis.call('DECRBY', KEYS[1], math.min(n, tonumber(ARGV[1])))"

const DECRBY_COMMAND_NAME = "civfixDecrByFloor"

type IncrExpire = (key: string, ttlSeconds: number) => Promise<number>

type IncrByExpire = (key: string, by: number, ttlSeconds: number) => Promise<number>

type DecrFloor = (key: string, by: number) => Promise<number>

type WithIncrExpire = RedisClient & {
  [INCRBY_COMMAND_NAME]?: (key: string, by: string, ttlMs: number) => Promise<unknown>
  [DECRBY_COMMAND_NAME]?: (key: string, by: string) => Promise<unknown>
}

export function attachAtomicIncr(redis: RedisClient): IncrExpire {
  const incrBy = attachAtomicIncrBy(redis)
  return (key: string, ttlSeconds: number): Promise<number> => incrBy(key, 1, ttlSeconds)
}

export function attachAtomicIncrBy(redis: RedisClient): IncrByExpire {
  const client = redis as WithIncrExpire
  if (typeof client[INCRBY_COMMAND_NAME] !== "function") {
    redis.defineCommand(INCRBY_COMMAND_NAME, { numberOfKeys: 1, lua: INCRBY_EXPIRE_LUA })
  }
  return async (key: string, by: number, ttlSeconds: number): Promise<number> => {
    const amount = Math.max(0, Math.floor(by))
    const ttlMs = Math.max(1, Math.ceil(ttlSeconds)) * 1000
    const result = await client[INCRBY_COMMAND_NAME]!(key, String(amount), ttlMs)
    return Number(result)
  }
}

export function attachAtomicDecrBy(redis: RedisClient): DecrFloor {
  const client = redis as WithIncrExpire
  if (typeof client[DECRBY_COMMAND_NAME] !== "function") {
    redis.defineCommand(DECRBY_COMMAND_NAME, { numberOfKeys: 1, lua: DECRBY_FLOOR_LUA })
  }
  return async (key: string, by: number): Promise<number> => {
    const amount = Math.max(0, Math.floor(by))
    const result = await client[DECRBY_COMMAND_NAME]!(key, String(amount))
    return Number(result)
  }
}
