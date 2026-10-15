import { describe, it, expect } from "vitest"
import { makeContainer } from "../../src/di.js"
import { loadEnv } from "../../src/env.js"
import {
  FakeStorage,
  FakeMailer,
  FakeJobs,
  FakeChatService,
  FakePushSender,
  FakeAbuseChecks,
  FakeGeocoder,
  FakeInboundMail,
  FakeRoutingProvider,
} from "@civfix/shared/fakes"
import { R2Storage } from "../../src/adapters/storage.r2.js"
import { PgBossJobs } from "../../src/adapters/jobs.pgboss.js"
import { WsChatService } from "../../src/adapters/chat-service.ws.js"
import {
  InMemoryBlocksRepository,
  InMemoryDmRepository,
} from "../../src/services/dm-repository.memory.js"

describe("DI container", () => {
  it("selects all fakes in dev/test mode and leaves db/redis uncreated", () => {
    const c = makeContainer(loadEnv({ NODE_ENV: "test" }))
    expect(c.storage).toBeInstanceOf(FakeStorage)
    expect(c.mailer).toBeInstanceOf(FakeMailer)
    expect(c.jobs).toBeInstanceOf(FakeJobs)
    expect(c.chatService).toBeInstanceOf(FakeChatService)
    expect(c.pushSender).toBeInstanceOf(FakePushSender)
    expect(c.abuseChecks).toBeInstanceOf(FakeAbuseChecks)
    expect(c.geocoder).toBeInstanceOf(FakeGeocoder)
    expect(c.inboundMail).toBeInstanceOf(FakeInboundMail)
    expect(c.routingProvider).toBeInstanceOf(FakeRoutingProvider)
    expect(c.dbHandle).toBeUndefined()
    expect(c.redis).toBeUndefined()
  })

  it("selects a real adapter when its fake flag is off", () => {
    const env = loadEnv({
      NODE_ENV: "test",
      USE_FAKE_STORAGE: "0",
      R2_ACCOUNT_ID: "a",
      R2_ACCESS_KEY_ID: "b",
      R2_SECRET_ACCESS_KEY: "c",
      R2_BUCKET: "d",
    })
    const c = makeContainer(env)
    expect(c.storage).toBeInstanceOf(R2Storage)
    expect(c.mailer).toBeInstanceOf(FakeMailer)
  })

  it("real WsChatService (Drizzle repo + Redis pub/sub) is wired when USE_FAKE_CHAT is off", () => {
    const env = loadEnv({
      NODE_ENV: "test",
      USE_FAKE_CHAT: "0",
      DATABASE_URL: "postgres://u:p@localhost:5432/civfix",
      REDIS_URL: "redis://localhost:6379",
    })
    const c = makeContainer(env)
    expect(c.chatService).toBeInstanceOf(WsChatService)
    expect(c.dbHandle).toBeDefined()
    expect(c.redis).toBeDefined()
  })

  it("real jobs adapter is wired when USE_FAKE_JOBS is off", () => {
    const env = loadEnv({
      NODE_ENV: "test",
      USE_FAKE_JOBS: "0",
      DATABASE_URL: "postgres://u:p@localhost:5432/civfix",
    })
    const c = makeContainer(env)
    expect(c.jobs).toBeInstanceOf(PgBossJobs)
  })

  it("close() is safe to call when nothing was created", async () => {
    const c = makeContainer(loadEnv({ NODE_ENV: "test" }))
    await expect(c.close()).resolves.toBeUndefined()
  })

  it("selects in-memory blocks/DM repos only when there is no database (F030)", () => {
    const c = makeContainer(loadEnv({ NODE_ENV: "test" }))
    expect(c.getBlocksRepo()).toBeInstanceOf(InMemoryBlocksRepository)
    expect(c.getDmRepo()).toBeInstanceOf(InMemoryDmRepository)
    expect(c.dbHandle).toBeUndefined()
  })

  it("selects Drizzle blocks/DM repos when a database is configured, even with USE_FAKE_CHAT on (F030)", () => {
    const c = makeContainer(
      loadEnv({
        NODE_ENV: "test",
        USE_FAKE_CHAT: "1",
        DATABASE_URL: "postgres://u:p@localhost:5432/civfix",
        REDIS_URL: "redis://localhost:6379",
      }),
    )
    expect(c.getBlocksRepo()).not.toBeInstanceOf(InMemoryBlocksRepository)
    expect(c.getDmRepo()).not.toBeInstanceOf(InMemoryDmRepository)
    expect(c.dbHandle).toBeDefined()
  })

  it("threads CF_TURNSTILE_HOSTNAMES into RealAbuseChecks, and omits it when unset (L16)", () => {
    const configOf = (checks: unknown): { turnstileHostnames?: readonly string[] } =>
      (checks as { config: { turnstileHostnames?: readonly string[] } }).config

    const wired = makeContainer(
      loadEnv({
        NODE_ENV: "test",
        USE_FAKE_ABUSE_NSFW: "0",
        CF_TURNSTILE_SECRET: "ts-secret",
        CF_TURNSTILE_HOSTNAMES: "civfix.org,www.civfix.org",
      }),
    )
    expect(configOf(wired.abuseChecks).turnstileHostnames).toEqual(["civfix.org", "www.civfix.org"])

    const unwired = makeContainer(
      loadEnv({ NODE_ENV: "test", USE_FAKE_ABUSE_NSFW: "0", CF_TURNSTILE_SECRET: "ts-secret" }),
    )
    expect(configOf(unwired.abuseChecks).turnstileHostnames).toBeUndefined()
  })
})

describe("DI container: inbound-mail storage is never public", () => {
  const realStorageEnv = {
    NODE_ENV: "test" as const,
    USE_FAKE_STORAGE: "0",
    R2_ACCOUNT_ID: "a",
    R2_ACCESS_KEY_ID: "b",
    R2_SECRET_ACCESS_KEY: "c",
    R2_BUCKET: "civfix-media",
  }

  type WithConfig = { config: { bucket: string; publicBase?: string } }

  it("builds the inbound storage on its own bucket and with no publicBase", () => {
    const env = loadEnv({
      ...realStorageEnv,
      R2_PUBLIC_BASE: "https://cdn.civfix.org",
      R2_INBOUND_BUCKET: "civfix-inbound",
    })
    const c = makeContainer(env)
    const media = (c.storage as unknown as WithConfig).config
    const inbound = (c.inboundStorage as unknown as WithConfig).config
    expect(inbound.bucket).toBe("civfix-inbound")
    expect(inbound.bucket).not.toBe(media.bucket)
    expect(media.publicBase).toBe("https://cdn.civfix.org")
    expect(inbound.publicBase).toBeUndefined()
  })

  it("throws rather than falling back to the media bucket when a public base is set", () => {
    const env = { ...loadEnv(realStorageEnv), R2_PUBLIC_BASE: "https://cdn.civfix.org" }
    expect(() => makeContainer(env)).toThrow(/R2_INBOUND_BUCKET is required/)
  })

  it("still shares the media bucket when nothing is publicly addressable", () => {
    const c = makeContainer(loadEnv(realStorageEnv))
    expect((c.inboundStorage as unknown as WithConfig).config.bucket).toBe("civfix-media")
  })
})
