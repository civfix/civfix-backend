import net from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from "vitest"
import {
  FakeAbuseChecks,
  FakeChatService,
  FakeGeocoder,
  FakeInboundMail,
  FakeJobs,
  FakeMailer,
  FakePushSender,
  FakeRoutingProvider,
  FakeSmsSender,
  FakeStorage,
  FakeUserChannel,
} from "@civfix/shared/fakes"
import { buildContainer, type Container } from "../../src/di.js"
import { loadEnv } from "../../src/env.js"
import { R2Storage } from "../../src/adapters/storage.r2.js"
import { LocalDiskStorage } from "../../src/adapters/storage.local.js"
import { OciMailer } from "../../src/adapters/mailer.oci.js"
import { TwilioSmsSender } from "../../src/adapters/sms-twilio.js"
import { CfInboundMail } from "../../src/adapters/inbound-mail.cf.js"
import { TigerGeocoder } from "../../src/adapters/geocoder.tiger.js"
import {
  CensusJurisdictionLookup,
  FakeJurisdictionLookup,
} from "../../src/adapters/jurisdiction-lookup.census.js"
import { WsChatService } from "../../src/adapters/chat-service.ws.js"
import { RedisUserChannel } from "../../src/adapters/user-channel.redis.js"
import { MultiPushSender } from "../../src/adapters/push-sender.js"
import { HttpRoutingProvider } from "../../src/adapters/routing-provider.js"
import { RealAbuseChecks } from "../../src/adapters/abuse-checks.js"
import { PgBossJobs } from "../../src/adapters/jobs.pgboss.js"
import {
  InMemoryBlocksRepository,
  InMemoryDmRepository,
} from "../../src/services/dm-repository.memory.js"

// Characterization net for the di.ts split: which implementation each seam resolves to, the Container
// surface, and the invariant that building a container never touches the network (tests and boot both
// rely on buildContainer being socket-free; DB and Redis are lazy, memoized getters).

// Unreachable on purpose: postgres.js and ioredis (lazyConnect) only dial on first query, so these are
// never contacted; the socket spy below turns any dial into a counted, refused call.
const LAZY_DATABASE_URL = "postgres://u:p@127.0.0.1:1/civfix"
const LAZY_REDIS_URL = "redis://127.0.0.1:1"

const R2_CREDENTIALS = {
  R2_ACCOUNT_ID: "acct",
  R2_ACCESS_KEY_ID: "akid",
  R2_SECRET_ACCESS_KEY: "secret",
  R2_BUCKET: "civfix-media",
}

function validProdEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    PORT: "8080",
    PUBLIC_API_URL: "https://api.civfix.org",
    WEB_ORIGINS: "https://civfix.org",
    DATABASE_URL: "postgres://user:pass@db:5432/civfix?sslmode=require",
    REDIS_URL: "redis://cache:6379",
    SESSION_SIGNING_KEY: "prod-session-signing-key-abcdefghijklmnop",
    ANON_TOKEN_SIGNING_KEY: "prod-anon-token-signing-key-abcdefghijklmnop",
    R2_ACCOUNT_ID: "acct",
    R2_ACCESS_KEY_ID: "akid",
    R2_SECRET_ACCESS_KEY: "secret",
    R2_BUCKET: "civfix-media",
    OCI_EMAIL_SMTP_HOST: "smtp.oci.example",
    OCI_EMAIL_SMTP_PORT: "587",
    OCI_EMAIL_SMTP_USER: "smtp-user",
    OCI_EMAIL_SMTP_PASS: "smtp-pass",
    TWILIO_ACCOUNT_SID: "ACtest",
    TWILIO_AUTH_TOKEN: "twilio-token",
    TWILIO_SMS_FROM: "+15550001111",
    UNSUBSCRIBE_SIGNING_KEY: "prod-unsubscribe-signing-key-abcdefghijklmnop",
    TICKET_TOKEN_SECRET: "prod-ticket-token-secret-abcdefghijklmnop",
  }
}

function allFakeContainer(): Container {
  return buildContainer(loadEnv({ NODE_ENV: "test" }))
}

let connectSpy: MockInstance

beforeEach(() => {
  connectSpy = vi.spyOn(net.Socket.prototype, "connect").mockImplementation(() => {
    throw new Error("di characterization: a socket connect was attempted")
  })
})

afterEach(() => {
  connectSpy.mockRestore()
})

describe("buildContainer characterization: no sockets", () => {
  it("builds an all-fake container without dialing anything and leaves db/redis unconstructed", () => {
    const c = allFakeContainer()
    expect(connectSpy).not.toHaveBeenCalled()
    expect(c.dbHandle).toBeUndefined()
    expect(c.redis).toBeUndefined()
    expect(c.usesRealDb).toBe(false)
    expect(c.usesRealRedis).toBe(false)
  })

  it("resolves every socket-free getter of an all-fake container without dialing or creating db/redis", () => {
    const c = allFakeContainer()
    void c.userChannel
    void c.pushSender
    c.getBlocksRepo()
    c.getDmRepo()
    c.getCounterStore()
    c.getByteMeter()
    c.getTicketTokenSigner()
    expect(connectSpy).not.toHaveBeenCalled()
    expect(c.dbHandle).toBeUndefined()
    expect(c.redis).toBeUndefined()
  })

  it("builds a fully real production container without dialing anything", () => {
    const c = buildContainer(loadEnv(validProdEnv()))
    void c.userChannel
    void c.pushSender
    expect(connectSpy).not.toHaveBeenCalled()
    expect(c.usesRealDb).toBe(true)
    expect(c.usesRealRedis).toBe(true)
  })

  it("close() on an all-fake container resolves without dialing", async () => {
    const c = allFakeContainer()
    await expect(c.close()).resolves.toBeUndefined()
    expect(connectSpy).not.toHaveBeenCalled()
  })
})

describe("buildContainer characterization: Container surface", () => {
  it("exposes exactly these keys, in this order", () => {
    expect(Object.keys(allFakeContainer())).toEqual([
      "env",
      "csrf",
      "storage",
      "inboundStorage",
      "developmentOnlyLocalObjectStores",
      "mailer",
      "smsSender",
      "inboundMail",
      "geocoder",
      "streetReverseGeocode",
      "jurisdictionLookup",
      "chatService",
      "userChannel",
      "pushSender",
      "routingProvider",
      "abuseChecks",
      "jobs",
      "dbHandle",
      "redis",
      "usesRealDb",
      "usesRealRedis",
      "getDb",
      "getRedis",
      "getDmRepo",
      "getBlocksRepo",
      "getVolunteerHoursRepo",
      "getCertificateRepo",
      "getAffiliationLoader",
      "getPostRepo",
      "getPostService",
      "getNotificationService",
      "getCounterStore",
      "getCache",
      "getByteMeter",
      "getTicketTokenSigner",
      "close",
    ])
  })

  it("exposes userChannel, pushSender, dbHandle and redis as lazy getters, the rest as values", () => {
    const c = allFakeContainer()
    const accessors = Object.entries(Object.getOwnPropertyDescriptors(c))
      .filter(([, d]) => d.get !== undefined)
      .map(([k]) => k)
    expect(accessors).toEqual(["userChannel", "pushSender", "dbHandle", "redis"])
  })

  it("passes the env through by identity", () => {
    const env = loadEnv({ NODE_ENV: "test" })
    expect(buildContainer(env).env).toBe(env)
  })

  it("reuses the media storage for inbound mail when storage is fake", () => {
    const c = allFakeContainer()
    expect(c.inboundStorage).toBe(c.storage)
    expect(c.developmentOnlyLocalObjectStores).toBeUndefined()
    expect(typeof c.streetReverseGeocode).toBe("function")
  })
})

describe("buildContainer characterization: seam selection", () => {
  it("picks every fake (plus NODE_ENV-driven fakes) in an all-fake test env", () => {
    const c = allFakeContainer()
    expect(c.storage).toBeInstanceOf(FakeStorage)
    expect(c.mailer).toBeInstanceOf(FakeMailer)
    expect(c.smsSender).toBeInstanceOf(FakeSmsSender)
    expect(c.inboundMail).toBeInstanceOf(FakeInboundMail)
    expect(c.geocoder).toBeInstanceOf(FakeGeocoder)
    expect(c.jurisdictionLookup).toBeInstanceOf(FakeJurisdictionLookup)
    expect(c.chatService).toBeInstanceOf(FakeChatService)
    expect(c.userChannel).toBeInstanceOf(FakeUserChannel)
    expect(c.pushSender).toBeInstanceOf(FakePushSender)
    expect(c.routingProvider).toBeInstanceOf(FakeRoutingProvider)
    expect(c.abuseChecks).toBeInstanceOf(FakeAbuseChecks)
    expect(c.jobs).toBeInstanceOf(FakeJobs)
    expect(c.getBlocksRepo()).toBeInstanceOf(InMemoryBlocksRepository)
    expect(c.getDmRepo()).toBeInstanceOf(InMemoryDmRepository)
  })

  it("picks every real adapter in a valid production env", () => {
    const c = buildContainer(loadEnv(validProdEnv()))
    expect(c.storage).toBeInstanceOf(R2Storage)
    expect(c.inboundStorage).toBeInstanceOf(R2Storage)
    expect(c.inboundStorage).not.toBe(c.storage)
    expect(c.mailer).toBeInstanceOf(OciMailer)
    expect(c.smsSender).toBeInstanceOf(TwilioSmsSender)
    expect(c.inboundMail).toBeInstanceOf(CfInboundMail)
    expect(c.geocoder).toBeInstanceOf(TigerGeocoder)
    expect(c.jurisdictionLookup).toBeInstanceOf(CensusJurisdictionLookup)
    expect(c.chatService).toBeInstanceOf(WsChatService)
    expect(c.userChannel).toBeInstanceOf(RedisUserChannel)
    expect(c.pushSender).toBeInstanceOf(MultiPushSender)
    expect(c.routingProvider).toBeInstanceOf(HttpRoutingProvider)
    expect(c.abuseChecks).toBeInstanceOf(RealAbuseChecks)
    expect(c.jobs).toBeInstanceOf(PgBossJobs)
  })

  it.each([
    ["USE_FAKE_STORAGE", (c: Container) => c.storage, R2Storage],
    ["USE_FAKE_MAILER", (c: Container) => c.mailer, OciMailer],
    ["USE_FAKE_SMS", (c: Container) => c.smsSender, TwilioSmsSender],
    ["USE_FAKE_GEOCODER", (c: Container) => c.geocoder, TigerGeocoder],
    ["USE_FAKE_CHAT", (c: Container) => c.chatService, WsChatService],
    ["USE_FAKE_USER_CHANNEL", (c: Container) => c.userChannel, RedisUserChannel],
    ["USE_FAKE_PUSH", (c: Container) => c.pushSender, MultiPushSender],
    ["USE_FAKE_ABUSE_NSFW", (c: Container) => c.abuseChecks, RealAbuseChecks],
    ["USE_FAKE_JOBS", (c: Container) => c.jobs, PgBossJobs],
  ] as const)(
    "%s=0 alone swaps only that seam to its real adapter, without dialing",
    (flag, seam, RealClass) => {
      const c = buildContainer(
        loadEnv({
          NODE_ENV: "test",
          [flag]: "0",
          ...R2_CREDENTIALS,
          DATABASE_URL: LAZY_DATABASE_URL,
          REDIS_URL: LAZY_REDIS_URL,
        }),
      )
      expect(seam(c)).toBeInstanceOf(RealClass)
      const baseline = buildContainer(
        loadEnv({ NODE_ENV: "test", DATABASE_URL: LAZY_DATABASE_URL, REDIS_URL: LAZY_REDIS_URL }),
      )
      expect(seam(baseline)).not.toBeInstanceOf(RealClass)
      expect(connectSpy).not.toHaveBeenCalled()
    },
  )

  it("keys inbound mail, routing and jurisdiction lookup off NODE_ENV, not a USE_FAKE_* flag", () => {
    const allRealOutsideProd = buildContainer(
      loadEnv({
        NODE_ENV: "test",
        USE_FAKE_STORAGE: "0",
        USE_FAKE_MAILER: "0",
        USE_FAKE_PUSH: "0",
        USE_FAKE_ABUSE_NSFW: "0",
        USE_FAKE_CHAT: "0",
        USE_FAKE_JOBS: "0",
        USE_FAKE_USER_CHANNEL: "0",
        USE_FAKE_GEOCODER: "0",
        USE_FAKE_SMS: "0",
        ...R2_CREDENTIALS,
        DATABASE_URL: LAZY_DATABASE_URL,
        REDIS_URL: LAZY_REDIS_URL,
      }),
    )
    expect(allRealOutsideProd.inboundMail).toBeInstanceOf(FakeInboundMail)
    expect(allRealOutsideProd.routingProvider).toBeInstanceOf(FakeRoutingProvider)
    expect(allRealOutsideProd.jurisdictionLookup).toBeInstanceOf(FakeJurisdictionLookup)
    expect(connectSpy).not.toHaveBeenCalled()
  })

  it("pins (known-questionable) real storage with no R2_BUCKET outside production: loadEnv accepts it, buildContainer throws an error that blames R2_PUBLIC_BASE", () => {
    const env = loadEnv({ NODE_ENV: "test", USE_FAKE_STORAGE: "0" })
    expect(env.R2_BUCKET).toBe("")
    expect(env.R2_PUBLIC_BASE).toBeUndefined()
    expect(() => buildContainer(env)).toThrow(
      "R2_INBOUND_BUCKET is required when R2_PUBLIC_BASE is set: refusing to write raw inbound email " +
        "into the public media bucket. Set a dedicated, non-public inbound bucket.",
    )
  })

  it("LOCAL_STORAGE_DIR selects local-disk media and inbound stores over both R2 and the fake", () => {
    const root = join(tmpdir(), "civfix-di-characterization")
    for (const useFakeStorage of ["1", "0"]) {
      const c = buildContainer(
        loadEnv({
          NODE_ENV: "test",
          USE_FAKE_STORAGE: useFakeStorage,
          LOCAL_STORAGE_DIR: root,
          PUBLIC_API_URL: "http://localhost:8080",
        }),
      )
      expect(c.storage).toBeInstanceOf(LocalDiskStorage)
      expect(c.inboundStorage).toBeInstanceOf(LocalDiskStorage)
      expect(c.inboundStorage).not.toBe(c.storage)
      expect(c.developmentOnlyLocalObjectStores).toEqual([c.storage, c.inboundStorage])
    }
  })

  it("picks Drizzle blocks/DM repos whenever a database is configured", () => {
    const c = buildContainer(loadEnv({ NODE_ENV: "test", DATABASE_URL: LAZY_DATABASE_URL }))
    expect(c.getBlocksRepo()).not.toBeInstanceOf(InMemoryBlocksRepository)
    expect(c.getDmRepo()).not.toBeInstanceOf(InMemoryDmRepository)
    expect(connectSpy).not.toHaveBeenCalled()
  })
})

describe("buildContainer characterization: memoized getters", () => {
  it("returns the same instance twice from every socket-free getter", () => {
    const c = allFakeContainer()
    expect(c.userChannel).toBe(c.userChannel)
    expect(c.pushSender).toBe(c.pushSender)
    expect(c.getBlocksRepo()).toBe(c.getBlocksRepo())
    expect(c.getDmRepo()).toBe(c.getDmRepo())
    expect(c.getCounterStore()).toBe(c.getCounterStore())
    expect(c.getByteMeter()).toBe(c.getByteMeter())
    expect(c.getTicketTokenSigner()).toBe(c.getTicketTokenSigner())
  })

  it("memoizes the lazy db/redis handles and everything built on them, without dialing", () => {
    const c = buildContainer(
      loadEnv({ NODE_ENV: "test", DATABASE_URL: LAZY_DATABASE_URL, REDIS_URL: LAZY_REDIS_URL }),
    )
    expect(c.dbHandle).toBeUndefined()
    expect(c.redis).toBeUndefined()
    const db = c.getDb()
    const redis = c.getRedis()
    expect(c.getDb()).toBe(db)
    expect(c.getRedis()).toBe(redis)
    expect(c.dbHandle).toBe(db)
    expect(c.redis).toBe(redis)
    expect(c.getCache()).toBe(c.getCache())
    expect(c.getVolunteerHoursRepo()).toBe(c.getVolunteerHoursRepo())
    expect(c.getCertificateRepo()).toBe(c.getCertificateRepo())
    expect(c.getAffiliationLoader()).toBe(c.getAffiliationLoader())
    expect(c.getPostRepo()).toBe(c.getPostRepo())
    expect(c.getPostService()).toBe(c.getPostService())
    expect(connectSpy).not.toHaveBeenCalled()
  })

  it("pins (known-questionable) getNotificationService rebuilding once when a logger first arrives", () => {
    const c = buildContainer(loadEnv({ NODE_ENV: "test", DATABASE_URL: LAZY_DATABASE_URL }))
    const bare = c.getNotificationService()
    expect(c.getNotificationService()).toBe(bare)
    const logger = { warn: vi.fn(), error: vi.fn() }
    const logged = c.getNotificationService(logger)
    expect(logged).not.toBe(bare)
    expect(c.getNotificationService()).toBe(logged)
    expect(c.getNotificationService(logger)).toBe(logged)
    expect(connectSpy).not.toHaveBeenCalled()
  })

  it("builds a fresh set of seams per container (no module-level sharing)", () => {
    const a = allFakeContainer()
    const b = allFakeContainer()
    expect(a.storage).not.toBe(b.storage)
    expect(a.jobs).not.toBe(b.jobs)
    expect(a.userChannel).not.toBe(b.userChannel)
  })
})
