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
    // Coalesce independent commands issued within the same event-loop tick into one pipelined
    // round-trip (e.g. the per-user PUBLISH fan-out in user-channel.redis.ts publishToUsers, which
    // issues N concurrent publishes via Promise.all). ioredis auto-pipelining batches these without
    // any call-site change; dependent awaited reads (e.g. the session get -> banned-marker get on the
    // auth hot path, which needs the userId from the first read) stay sequential by necessity.
    enableAutoPipelining: true,
  })
}
