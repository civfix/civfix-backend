import { Redis } from "ioredis"

export type RedisClient = Redis

export const REDIS_COMMAND_TIMEOUT_MS = 5000

const REDIS_MAX_RETRIES_PER_REQUEST = 2

export interface MakeRedisOptions {
  onError?: (err: Error) => void
  commandTimeout?: number
}

export function attachRedisErrorHandler(client: RedisClient, onError?: (err: Error) => void): void {
  client.on("error", (err: Error) => {
    if (onError) onError(err)
  })
}

export function makeRedis(redisUrl: string, opts: MakeRedisOptions = {}): RedisClient {
  if (!redisUrl) {
    throw new Error("makeRedis: redisUrl is required")
  }
  const client = new Redis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: REDIS_MAX_RETRIES_PER_REQUEST,
    commandTimeout: opts.commandTimeout ?? REDIS_COMMAND_TIMEOUT_MS,
    enableReadyCheck: true,
    enableAutoPipelining: true,
  })
  attachRedisErrorHandler(client, opts.onError)
  return client
}
