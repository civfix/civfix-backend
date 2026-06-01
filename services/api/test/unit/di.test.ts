import { describe, it, expect } from "vitest"
import { buildContainer } from "../../src/di.js"
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

describe("DI container", () => {
  it("selects all fakes in dev/test mode and leaves db/redis uncreated", () => {
    const c = buildContainer(loadEnv({ NODE_ENV: "test" }))
    expect(c.storage).toBeInstanceOf(FakeStorage)
    expect(c.mailer).toBeInstanceOf(FakeMailer)
    expect(c.jobs).toBeInstanceOf(FakeJobs)
    expect(c.chatService).toBeInstanceOf(FakeChatService)
    expect(c.pushSender).toBeInstanceOf(FakePushSender)
    expect(c.abuseChecks).toBeInstanceOf(FakeAbuseChecks)
    expect(c.geocoder).toBeInstanceOf(FakeGeocoder)
    expect(c.inboundMail).toBeInstanceOf(FakeInboundMail)
    expect(c.routingProvider).toBeInstanceOf(FakeRoutingProvider)
    // No real seam needed db/redis, so handles stay undefined (server boots with no infra).
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
    const c = buildContainer(env)
    expect(c.storage).toBeInstanceOf(R2Storage)
    // Still a fake everywhere else.
    expect(c.mailer).toBeInstanceOf(FakeMailer)
  })

  it("real WsChatService (Drizzle repo + Redis pub/sub) is wired when USE_FAKE_CHAT is off", () => {
    const env = loadEnv({
      NODE_ENV: "test",
      USE_FAKE_CHAT: "0",
      DATABASE_URL: "postgres://u:p@localhost:5432/civfix",
      REDIS_URL: "redis://localhost:6379",
    })
    const c = buildContainer(env)
    // The real chat service builds over the lazily-created db + redis handles (no connection opens yet).
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
    const c = buildContainer(env)
    expect(c.jobs).toBeInstanceOf(PgBossJobs)
  })

  it("close() is safe to call when nothing was created", async () => {
    const c = buildContainer(loadEnv({ NODE_ENV: "test" }))
    await expect(c.close()).resolves.toBeUndefined()
  })
})
