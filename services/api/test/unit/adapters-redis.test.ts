import { describe, it, expect, vi } from "vitest"
import { EventEmitter } from "node:events"
import {
  makeRedis,
  attachRedisErrorHandler,
  REDIS_COMMAND_TIMEOUT_MS,
  type RedisClient,
} from "../../src/adapters/redis.js"

describe("attachRedisErrorHandler (F129)", () => {
  it("routes an ioredis 'error' event to onError instead of the process falling to console.error", () => {
    const client = new EventEmitter() as unknown as RedisClient
    const onError = vi.fn()
    attachRedisErrorHandler(client, onError)
    const boom = new Error("ECONNREFUSED")
    ;(client as unknown as EventEmitter).emit("error", boom)
    expect(onError).toHaveBeenCalledWith(boom)
  })

  it("swallows the error event safely when no onError is supplied (never rethrows)", () => {
    const client = new EventEmitter() as unknown as RedisClient
    attachRedisErrorHandler(client)
    expect(() => (client as unknown as EventEmitter).emit("error", new Error("x"))).not.toThrow()
  })
})

describe("makeRedis (F129)", () => {
  it("attaches an error handler and applies a default commandTimeout, without connecting", () => {
    const onError = vi.fn()
    const client = makeRedis("redis://127.0.0.1:6379", { onError })
    try {
      expect((client.options as { commandTimeout?: number }).commandTimeout).toBe(
        REDIS_COMMAND_TIMEOUT_MS,
      )
      client.emit("error", new Error("mid-day eviction"))
      expect(onError).toHaveBeenCalledTimes(1)
    } finally {
      client.disconnect()
    }
  })

  it("honors an explicit commandTimeout override", () => {
    const client = makeRedis("redis://127.0.0.1:6379", { commandTimeout: 1234 })
    try {
      expect((client.options as { commandTimeout?: number }).commandTimeout).toBe(1234)
    } finally {
      client.disconnect()
    }
  })
})
