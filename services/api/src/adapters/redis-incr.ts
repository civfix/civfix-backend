import type { RedisClient } from "./redis.js"

// Lua kept as a STATIC literal (never composed from input) per the atomicity rule: INCR + PEXPIRE NX
// in one round-trip so a crash/timeout/dropped connection can't leave a TTL-less counter (which would
// rate-limit an IP/H3 cell, or lock an email out of OTP, forever). PEXPIRE only fires when INCR
// created the key (n == 1), so the window stays anchored to its first hit; existing keys keep their
// expiry. MULTI/pipeline do NOT give this guarantee — a drop between queued commands still strands the
// key without a TTL.
const INCR_EXPIRE_LUA =
  "local n = redis.call('INCR', KEYS[1]); if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end; return n"

const COMMAND_NAME = "civfixIncrExpire"

type IncrExpire = (key: string, ttlSeconds: number) => Promise<number>

// ioredis adds defineCommand'd methods dynamically, so they aren't on the typed client surface.
type WithIncrExpire = RedisClient & {
  [COMMAND_NAME]?: (key: string, ttlMs: number) => Promise<unknown>
}

/**
 * Register the atomic INCR+PEXPIRE Lua command on `redis` (idempotent across calls on the same client)
 * and return a function that runs it. The returned fn increments the integer at `key`, anchoring the
 * key's TTL to `ttlSeconds` only on the hit that creates it, and resolves to the new counter value.
 */
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
