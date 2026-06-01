/**
 * ioredis client factory.
 *
 * Lazy: `lazyConnect: true` means no socket opens until the first command. This keeps the server
 * bootable with no REDIS_URL when fakes are selected.
 */

import { Redis } from "ioredis"

export type RedisClient = Redis

/**
 * Build an ioredis client. Connection is deferred (lazyConnect) so importing/constructing does not
 * require a reachable Redis. Call `client.connect()` or issue a command to actually connect.
 */
export function makeRedis(redisUrl: string): RedisClient {
  if (!redisUrl) {
    throw new Error("makeRedis: redisUrl is required")
  }
  return new Redis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 2,
    enableReadyCheck: true,
  })
}
