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

  it("threads CF_TURNSTILE_HOSTNAMES into RealAbuseChecks, and omits it when unset (L16)", () => {
    // The hostname assertion existed in abuse-checks but nothing ever supplied the list, so a token minted
    // on another origin using our sitekey could be replayed. Read back off the constructed instance: the
    // wiring IS the fix, so asserting the env value reaches the adapter is the only meaningful pin.
    const configOf = (checks: unknown): { turnstileHostnames?: readonly string[] } =>
      (checks as { config: { turnstileHostnames?: readonly string[] } }).config

    const wired = buildContainer(
      loadEnv({
        NODE_ENV: "test",
        USE_FAKE_ABUSE_NSFW: "0",
        CF_TURNSTILE_SECRET: "ts-secret",
        CF_TURNSTILE_HOSTNAMES: "civfix.org,www.civfix.org",
      }),
    )
    expect(configOf(wired.abuseChecks).turnstileHostnames).toEqual(["civfix.org", "www.civfix.org"])

    // Unset -> the key is OMITTED rather than passed as [], so abuse-checks still logs its one-time
    // "not configured" notice instead of reading as "configured with an empty allowlist".
    const unwired = buildContainer(
      loadEnv({ NODE_ENV: "test", USE_FAKE_ABUSE_NSFW: "0", CF_TURNSTILE_SECRET: "ts-secret" }),
    )
    expect(configOf(unwired.abuseChecks).turnstileHostnames).toBeUndefined()
  })
})

/**
 * H10: raw inbound email (.eml + attachments) must never be reachable on the public CDN. Two guarantees
 * live in di.ts — the inbound Storage is built WITHOUT a publicBase, and the old silent
 * `R2_INBOUND_BUCKET ?? R2_BUCKET` fallback cannot route inbound mail into the published media bucket.
 */
describe("DI container: inbound-mail storage is never public", () => {
  const realStorageEnv = {
    NODE_ENV: "test" as const,
    USE_FAKE_STORAGE: "0",
    R2_ACCOUNT_ID: "a",
    R2_ACCESS_KEY_ID: "b",
    R2_SECRET_ACCESS_KEY: "c",
    R2_BUCKET: "civfix-media",
  }

  /** R2Storage keeps its config privately; read what we assert on without widening the public type. */
  type WithConfig = { config: { bucket: string; publicBase?: string } }

  it("builds the inbound storage on its own bucket and with no publicBase", () => {
    const env = loadEnv({
      ...realStorageEnv,
      R2_PUBLIC_BASE: "https://cdn.civfix.org",
      R2_INBOUND_BUCKET: "civfix-inbound",
    })
    const c = buildContainer(env)
    const media = (c.storage as unknown as WithConfig).config
    const inbound = (c.inboundStorage as unknown as WithConfig).config
    expect(inbound.bucket).toBe("civfix-inbound")
    expect(inbound.bucket).not.toBe(media.bucket)
    // The media bucket keeps its CDN base; the inbound one must NOT have one at all.
    expect(media.publicBase).toBe("https://cdn.civfix.org")
    expect(inbound.publicBase).toBeUndefined()
  })

  it("throws rather than falling back to the media bucket when a public base is set", () => {
    // loadEnv is the first line of defence; construct the env object directly to prove di.ts also
    // refuses, so no future env change can reintroduce the leak silently.
    const env = { ...loadEnv(realStorageEnv), R2_PUBLIC_BASE: "https://cdn.civfix.org" }
    expect(() => buildContainer(env)).toThrow(/R2_INBOUND_BUCKET is required/)
  })

  it("still shares the media bucket when nothing is publicly addressable", () => {
    const c = buildContainer(loadEnv(realStorageEnv))
    expect((c.inboundStorage as unknown as WithConfig).config.bucket).toBe("civfix-media")
  })
})
