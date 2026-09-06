import type { RedisClient } from "./redis.js"

const INCR_EXPIRE_LUA =
  "local n = redis.call('INCR', KEYS[1]); if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end; return n"

const INCRBY_EXPIRE_LUA =
  "local n = redis.call('INCRBY', KEYS[1], ARGV[1]); if n == tonumber(ARGV[1]) then redis.call('PEXPIRE', KEYS[1], ARGV[2]) end; return n"

const COMMAND_NAME = "civfixIncrExpire"

const INCRBY_COMMAND_NAME = "civfixIncrByExpire"

type IncrExpire = (key: string, ttlSeconds: number) => Promise<number>

type IncrByExpire = (key: string, by: number, ttlSeconds: number) => Promise<number>

type WithIncrExpire = RedisClient & {
  [COMMAND_NAME]?: (key: string, ttlMs: number) => Promise<unknown>
  [INCRBY_COMMAND_NAME]?: (key: string, by: string, ttlMs: number) => Promise<unknown>
}

export function attachAtomicIncr(redis: RedisClient): IncrExpire {
  const client = redis as WithIncrExpire
  if (typeof client[COMMAND_NAME] !== "function") {
    redis.defineCommand(COMMAND_NAME, { numberOfKeys: 1, lua: INCR_EXPIRE_LUA })
  }
  return async (key: string, ttlSeconds: number): Promise<number> => {
    const ttlMs = Math.max(1, Math.ceil(ttlSeconds)) * 1000
    const result = await client[COMMAND_NAME]!(key, ttlMs)
    return Number(result)
  }
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
