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

const MS_PER_SECOND = 1000

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

function defineOnce(
  redis: RedisClient,
  name: typeof INCRBY_COMMAND_NAME | typeof DECRBY_COMMAND_NAME,
  lua: string,
): WithIncrExpire {
  const client = redis as WithIncrExpire
  if (typeof client[name] !== "function") {
    redis.defineCommand(name, { numberOfKeys: 1, lua })
  }
  return client
}

function wholeAmount(by: number): string {
  return String(Math.max(0, Math.floor(by)))
}

export function attachAtomicIncrBy(redis: RedisClient): IncrByExpire {
  const client = defineOnce(redis, INCRBY_COMMAND_NAME, INCRBY_EXPIRE_LUA)
  return async (key: string, by: number, ttlSeconds: number): Promise<number> => {
    const ttlMs = Math.max(1, Math.ceil(ttlSeconds)) * MS_PER_SECOND
    const result = await client[INCRBY_COMMAND_NAME]!(key, wholeAmount(by), ttlMs)
    return Number(result)
  }
}

export function attachAtomicDecrBy(redis: RedisClient): DecrFloor {
  const client = defineOnce(redis, DECRBY_COMMAND_NAME, DECRBY_FLOOR_LUA)
  return async (key: string, by: number): Promise<number> => {
    const result = await client[DECRBY_COMMAND_NAME]!(key, wholeAmount(by))
    return Number(result)
  }
}
