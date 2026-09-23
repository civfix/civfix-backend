import type {
  AbuseChecks,
  ChatService,
  Geocoder,
  InboundMail,
  Jobs,
  Mailer,
  PushSender,
  RoutingProvider,
  SmsSender,
  Storage,
  UserChannel,
} from "@civfix/shared/interfaces"
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

import type { FastifyBaseLogger } from "fastify"

import type { Env } from "./env.js"
import { makeCsrf, type Csrf } from "./auth/csrf.js"
import { RedisCacheClient, type CacheClient } from "./auth/cache.js"
import { makeDb, type DbHandle } from "./db/client.js"
import { makeRedis, type RedisClient } from "./adapters/redis.js"

import { R2Storage } from "./adapters/storage.r2.js"
import {
  LOCAL_STORAGE_DEV_SIGNING_KEY,
  LocalDiskStorage,
  type LocalStorageNamespace,
} from "./adapters/storage.local.js"
import { OciMailer } from "./adapters/mailer.oci.js"
import { TwilioSmsSender } from "./adapters/sms-twilio.js"
import { CfInboundMail } from "./adapters/inbound-mail.cf.js"
import { TigerGeocoder } from "./adapters/geocoder.tiger.js"
import { makePhotonReverseGeocode } from "./adapters/reverse-geocode.photon.js"
import { makeMapboxReverseGeocode } from "./adapters/reverse-geocode.mapbox.js"
import { chainReverse, type ReverseGeocode } from "./adapters/reverse-geocode.chain.js"
import {
  CensusJurisdictionLookup,
  FakeJurisdictionLookup,
  type JurisdictionLookup,
} from "./adapters/jurisdiction-lookup.census.js"
import { WsChatService } from "./adapters/chat-service.ws.js"
import { RedisChatPubSub } from "./adapters/chat-pubsub.js"
import { RedisUserChannel } from "./adapters/user-channel.redis.js"
import { makeDrizzleChatRepository } from "./services/chat-repository.drizzle.js"
import { makeDrizzleDmRepository, type DmRepository } from "./services/dm-repository.drizzle.js"
import { makeMediaPresigner, makePrivateMediaPresigner } from "./services/media-presign.js"
import {
  makeDrizzleBlocksRepository,
  type BlocksRepository,
} from "./services/blocks-repository.drizzle.js"
import { makeDrizzleVolunteerHoursRepository } from "./services/volunteer-hours-repository.drizzle.js"
import type { VolunteerHoursRepository } from "./services/volunteer-hours-service.js"
import { makeDrizzleCertificateRepository } from "./services/certificate-repository.drizzle.js"
import type { CertificateRepository } from "./services/certificate-service.js"
import {
  makeDrizzlePostRepository,
  type PostRepository,
} from "./services/post-repository.drizzle.js"
import { makePostService, type PostService } from "./services/post-service.js"
import { makeFeedPresence, type FeedPresence } from "./services/feed-presence.js"
import {
  makeNotificationService,
  type NotificationService,
} from "./services/notification-service.js"
import { makeDrizzleNotificationRepository } from "./services/notification-repository.drizzle.js"
import { MEDIA_GET_URL_TTL_SEC } from "./services/media-intake-service.js"
import { makeAffiliationLoader, type AffiliationLoader } from "./services/affiliation.js"
import { RedisByteMeter, type ByteMeter } from "./services/media-byte-quota.js"
import { makeTicketTokenSigner, type TicketTokenSigner } from "./services/host/ticket-token.js"
import { RedisCounterStore, type CounterStore } from "./abuse/counter-store.js"
import { InMemoryBlocksRepository, InMemoryDmRepository } from "./services/dm-repository.memory.js"
import { MultiPushSender } from "./adapters/push-sender.js"
import { HttpRoutingProvider } from "./adapters/routing-provider.js"
import { RealAbuseChecks } from "./adapters/abuse-checks.js"
import { PgBossJobs } from "./adapters/jobs.pgboss.js"

export interface Container {
  readonly env: Env

  readonly csrf: Csrf

  readonly storage: Storage
  readonly inboundStorage: Storage
  readonly developmentOnlyLocalObjectStores: readonly LocalDiskStorage[] | undefined
  readonly mailer: Mailer
  readonly smsSender: SmsSender
  readonly inboundMail: InboundMail
  readonly geocoder: Geocoder
  readonly streetReverseGeocode: ReverseGeocode
  readonly jurisdictionLookup: JurisdictionLookup
  readonly chatService: ChatService
  readonly userChannel: UserChannel
  readonly pushSender: PushSender
  readonly routingProvider: RoutingProvider
  readonly abuseChecks: AbuseChecks
  readonly jobs: Jobs

  readonly dbHandle: DbHandle | undefined
  readonly redis: RedisClient | undefined

  readonly usesRealDb: boolean
  readonly usesRealRedis: boolean

  getDb(): DbHandle
  getRedis(): RedisClient

  getDmRepo(): DmRepository
  getBlocksRepo(): BlocksRepository
  getVolunteerHoursRepo(): VolunteerHoursRepository
  getCertificateRepo(): CertificateRepository
  getAffiliationLoader(): AffiliationLoader
  getPostRepo(): PostRepository
  getPostService(): PostService
  getNotificationService(logger?: NotificationLogger): NotificationService
  getCounterStore(): CounterStore
  getCache(): CacheClient
  getByteMeter(): ByteMeter
  getTicketTokenSigner(): TicketTokenSigner

  close(): Promise<void>
}

export type NotificationLogger = Pick<FastifyBaseLogger, "warn" | "error">

interface AdapterLogger {
  warn(obj: unknown, msg?: string): void
  error(obj: unknown, msg?: string): void
}

// Only reached when no server logger was ever attached (a run without a database never builds the
// notification service that carries it).
const PRE_SERVER_LOGGER: AdapterLogger = {
  warn: (obj, msg) => console.warn(msg ?? "", obj),
  error: (obj, msg) => console.error(msg ?? "", obj),
}

export function buildContainer(env: Env): Container {
  let dbHandle: DbHandle | undefined
  let redis: RedisClient | undefined

  let serverLogger: NotificationLogger | undefined

  const csrf = makeCsrf(env)

  // Adapters are built before buildServer hands over its logger, so they get a forwarder that resolves
  // the server logger at call time instead of capturing a console fallback at construction.
  const adapterLogger: AdapterLogger = {
    warn: (obj, msg) => forwardLog("warn", obj, msg),
    error: (obj, msg) => forwardLog("error", obj, msg),
  }
  function forwardLog(level: "warn" | "error", obj: unknown, msg: string | undefined): void {
    if (serverLogger !== undefined) serverLogger[level](obj, msg)
    else PRE_SERVER_LOGGER[level](obj, msg)
  }

  let closed = false
  // A getter reached after shutdown would otherwise open a fresh pool that nothing ever closes.
  function assertOpen(): void {
    if (closed) throw new Error("DI container is closed")
  }

  function getDb(): DbHandle {
    assertOpen()
    if (!dbHandle) dbHandle = makeDb(env.DATABASE_URL)
    return dbHandle
  }
  function getRedis(): RedisClient {
    assertOpen()
    if (!redis) {
      redis = makeRedis(env.REDIS_URL, {
        onError: (err) => serverLogger?.error({ err, component: "redis" }, "redis client error"),
      })
    }
    return redis
  }

  let dmRepo: DmRepository | undefined
  let blocksRepo: BlocksRepository | undefined
  let volunteerHoursRepo: VolunteerHoursRepository | undefined
  function getVolunteerHoursRepo(): VolunteerHoursRepository {
    if (!volunteerHoursRepo) {
      volunteerHoursRepo = makeDrizzleVolunteerHoursRepository(getDb().sql)
    }
    return volunteerHoursRepo
  }
  let certificateRepo: CertificateRepository | undefined
  function getCertificateRepo(): CertificateRepository {
    if (!certificateRepo) {
      certificateRepo = makeDrizzleCertificateRepository(getDb().sql)
    }
    return certificateRepo
  }
  const hasDatabase = env.DATABASE_URL.length > 0
  function getBlocksRepo(): BlocksRepository {
    if (!blocksRepo) {
      blocksRepo = hasDatabase
        ? makeDrizzleBlocksRepository(getDb().sql)
        : new InMemoryBlocksRepository()
    }
    return blocksRepo
  }
  function getDmRepo(): DmRepository {
    if (!dmRepo) {
      if (hasDatabase) {
        dmRepo = makeDrizzleDmRepository(getDb().sql, presignPrivateMedia)
      } else {
        const blocks = getBlocksRepo()
        dmRepo = new InMemoryDmRepository((a, b) => blocks.isBlockedEitherWay(a, b))
      }
    }
    return dmRepo
  }

  let postRepo: PostRepository | undefined
  let affiliationLoader: AffiliationLoader | undefined
  function getAffiliationLoader(): AffiliationLoader {
    if (!affiliationLoader) {
      affiliationLoader = makeAffiliationLoader(getDb().sql, (k: string) =>
        storage.presignGet(k, MEDIA_GET_URL_TTL_SEC),
      )
    }
    return affiliationLoader
  }

  function getPostRepo(): PostRepository {
    if (!postRepo) {
      postRepo = makeDrizzlePostRepository(getDb().sql, {
        presignMedia,
        presignAvatar: (k: string) => storage.presignGet(k, MEDIA_GET_URL_TTL_SEC),
        affiliations: getAffiliationLoader(),
      })
    }
    return postRepo
  }

  let feedPresence: FeedPresence | undefined
  function getFeedPresence(): FeedPresence {
    if (!feedPresence) {
      feedPresence = makeFeedPresence({
        ...(env.REDIS_URL.length > 0 ? { cache: getCache() } : {}),
        config: env.FEED_RANKING,
        ...(serverLogger !== undefined ? { logger: serverLogger } : {}),
      })
    }
    return feedPresence
  }

  let postService: PostService | undefined
  function getPostService(): PostService {
    if (!postService) {
      postService = makePostService({
        repo: getPostRepo(),
        sql: getDb().sql,
        notifier: getNotificationService(),
        isBlockedEitherWay: (a: string, b: string) => getBlocksRepo().isBlockedEitherWay(a, b),
        feedRanking: env.FEED_RANKING,
        feedPresence: getFeedPresence(),
        ...(env.USE_FAKE_USER_CHANNEL ? {} : { userChannel: getUserChannel() }),
      })
    }
    return postService
  }

  let notificationService: NotificationService | undefined
  let notificationLoggerWired = false
  function getNotificationService(logger?: NotificationLogger): NotificationService {
    if (logger !== undefined) serverLogger ??= logger
    if (notificationService === undefined || (logger !== undefined && !notificationLoggerWired)) {
      notificationService = makeNotificationService({
        repo: makeDrizzleNotificationRepository(getDb().sql),
        pushSender: getPushSender(),
        userChannel: getUserChannel(),
        ...(logger !== undefined ? { logger } : {}),
      })
      notificationLoggerWired = logger !== undefined
    }
    return notificationService
  }

  let redisCounters: CounterStore | undefined
  const lazyCounters: CounterStore = {
    incr: (key, ttlSeconds) =>
      (redisCounters ??= new RedisCounterStore(getRedis())).incr(key, ttlSeconds),
    incrBy: (key, by, ttlSeconds) =>
      (redisCounters ??= new RedisCounterStore(getRedis())).incrBy(key, by, ttlSeconds),
  }
  function getCounterStore(): CounterStore {
    return lazyCounters
  }

  let cacheClient: CacheClient | undefined
  function getCache(): CacheClient {
    if (!cacheClient) cacheClient = new RedisCacheClient(getRedis())
    return cacheClient
  }

  let redisByteMeter: ByteMeter | undefined
  const lazyByteMeter: ByteMeter = {
    add: (subject, bytes) =>
      (redisByteMeter ??= new RedisByteMeter(getRedis())).add(subject, bytes),
  }
  function getByteMeter(): ByteMeter {
    return lazyByteMeter
  }

  let ticketTokenSigner: TicketTokenSigner | undefined
  function getTicketTokenSigner(): TicketTokenSigner {
    if (!ticketTokenSigner) {
      ticketTokenSigner = makeTicketTokenSigner(env.TICKET_TOKEN_SECRET.trim())
    }
    return ticketTokenSigner
  }

  const localStorageDir = env.LOCAL_STORAGE_DIR
  const usesR2 = localStorageDir === undefined && !env.USE_FAKE_STORAGE

  function makeLocalDiskStorage(
    rootDirectory: string,
    namespace: LocalStorageNamespace,
  ): LocalDiskStorage {
    return new LocalDiskStorage({
      rootDirectory,
      namespace,
      publicApiUrl: env.PUBLIC_API_URL,
      signingKey: env.LOCAL_STORAGE_SIGNING_KEY ?? LOCAL_STORAGE_DEV_SIGNING_KEY,
      nodeEnv: env.NODE_ENV,
    })
  }

  const localMediaStore =
    localStorageDir !== undefined ? makeLocalDiskStorage(localStorageDir, "media") : undefined
  const localInboundStore =
    localStorageDir !== undefined ? makeLocalDiskStorage(localStorageDir, "inbound") : undefined
  const localObjectStores =
    localMediaStore !== undefined && localInboundStore !== undefined
      ? ([localMediaStore, localInboundStore] as const)
      : undefined

  const storage: Storage =
    localMediaStore ??
    (env.USE_FAKE_STORAGE
      ? new FakeStorage()
      : new R2Storage({
          accountId: env.R2_ACCOUNT_ID,
          accessKeyId: env.R2_ACCESS_KEY_ID,
          secretAccessKey: env.R2_SECRET_ACCESS_KEY,
          bucket: env.R2_BUCKET,
          ...(env.R2_PUBLIC_BASE !== undefined ? { publicBase: env.R2_PUBLIC_BASE } : {}),
        }))

  const presignMedia = makeMediaPresigner(storage)

  const presignPrivateMedia = makePrivateMediaPresigner(storage)

  const inboundBucket =
    env.R2_INBOUND_BUCKET ?? (env.R2_PUBLIC_BASE === undefined ? env.R2_BUCKET : "")
  if (usesR2 && inboundBucket.length === 0) {
    throw new Error(
      "R2_INBOUND_BUCKET is required when R2_PUBLIC_BASE is set: refusing to write raw inbound email " +
        "into the public media bucket. Set a dedicated, non-public inbound bucket.",
    )
  }
  const inboundStorage: Storage =
    localInboundStore ??
    (usesR2
      ? new R2Storage({
          accountId: env.R2_ACCOUNT_ID,
          accessKeyId: env.R2_ACCESS_KEY_ID,
          secretAccessKey: env.R2_SECRET_ACCESS_KEY,
          bucket: inboundBucket,
        })
      : storage)

  const mailer: Mailer = env.USE_FAKE_MAILER
    ? new FakeMailer()
    : new OciMailer({
        host: env.OCI_EMAIL_SMTP_HOST,
        port: env.OCI_EMAIL_SMTP_PORT,
        user: env.OCI_EMAIL_SMTP_USER,
        pass: env.OCI_EMAIL_SMTP_PASS,
        fromNoReply: env.MAIL_FROM_NOREPLY,
        fromOutreach: env.MAIL_FROM_OUTREACH,
        timeoutMs: env.OCI_EMAIL_SMTP_TIMEOUT_MS,
        logger: adapterLogger,
      })

  const smsSender: SmsSender = env.USE_FAKE_SMS
    ? new FakeSmsSender()
    : new TwilioSmsSender({
        accountSid: env.TWILIO_ACCOUNT_SID,
        authToken: env.TWILIO_AUTH_TOKEN,
        from: env.TWILIO_SMS_FROM,
      })

  const geocoder: Geocoder = env.USE_FAKE_GEOCODER
    ? new FakeGeocoder()
    : new TigerGeocoder({ getSql: () => getDb().sql })

  const streetReverseGeocode: ReverseGeocode = chainReverse(
    env.MAPBOX_TOKEN ? makeMapboxReverseGeocode({ token: env.MAPBOX_TOKEN }) : null,
    makePhotonReverseGeocode(),
  )

  const jurisdictionLookup: JurisdictionLookup =
    env.NODE_ENV === "production"
      ? new CensusJurisdictionLookup({
          baseUrl: env.CENSUS_GEOCODER_URL,
          timeoutMs: env.CENSUS_GEOCODER_TIMEOUT_MS,
        })
      : new FakeJurisdictionLookup()

  const inboundMail: InboundMail =
    env.NODE_ENV === "production"
      ? new CfInboundMail({
          replyDomain: env.MAIL_REPLY_DOMAIN,
          ...(env.CF_EMAIL_WEBHOOK_SECRET !== undefined
            ? { webhookSecret: env.CF_EMAIL_WEBHOOK_SECRET }
            : {}),
        })
      : new FakeInboundMail(env.MAIL_REPLY_DOMAIN)

  const routingProvider: RoutingProvider =
    env.NODE_ENV === "production" ? new HttpRoutingProvider() : new FakeRoutingProvider()

  const abuseChecks: AbuseChecks = env.USE_FAKE_ABUSE_NSFW
    ? new FakeAbuseChecks()
    : new RealAbuseChecks({
        ...(env.CF_TURNSTILE_SECRET !== undefined
          ? { turnstileSecret: env.CF_TURNSTILE_SECRET }
          : {}),
        ...(env.CF_TURNSTILE_HOSTNAMES.length > 0
          ? { turnstileHostnames: env.CF_TURNSTILE_HOSTNAMES }
          : {}),
        useRealNsfw: env.USE_REAL_NSFW,
        log: (line, extra) => adapterLogger.warn(extra ?? {}, line),
      })

  let sharedPubSub: RedisChatPubSub | undefined
  function getSharedPubSub(): RedisChatPubSub {
    if (!sharedPubSub) {
      sharedPubSub = new RedisChatPubSub(getRedis(), (err) =>
        serverLogger?.error(
          { err, component: "redis", role: "subscriber" },
          "redis subscriber error",
        ),
      )
    }
    return sharedPubSub
  }

  const chatService: ChatService = env.USE_FAKE_CHAT
    ? new FakeChatService()
    : new WsChatService({
        repo: makeDrizzleChatRepository(getDb().sql, presignPrivateMedia),
        pubsub: getSharedPubSub(),
      })

  let userChannel: UserChannel | undefined
  function getUserChannel(): UserChannel {
    if (!userChannel) {
      userChannel = env.USE_FAKE_USER_CHANNEL
        ? new FakeUserChannel()
        : new RedisUserChannel({
            pubsub: getSharedPubSub(),
            ...(serverLogger !== undefined ? { logger: serverLogger } : {}),
          })
    }
    return userChannel
  }

  let pushSender: PushSender | undefined
  function getPushSender(): PushSender {
    if (!pushSender) {
      pushSender = env.USE_FAKE_PUSH
        ? new FakePushSender()
        : new MultiPushSender({
            db: getDb().db,
            config: buildPushConfig(env),
            counters: getCounterStore(),
            logger: adapterLogger,
          })
    }
    return pushSender
  }

  const jobs: Jobs = env.USE_FAKE_JOBS
    ? new FakeJobs()
    : new PgBossJobs({ connectionString: env.DATABASE_URL, logger: adapterLogger })

  async function close(): Promise<void> {
    closed = true
    const maybePgBoss = jobs as { stop?: () => Promise<void> }
    if (typeof maybePgBoss.stop === "function") {
      await maybePgBoss.stop()
    }
    if (userChannel) {
      const maybeUserChannel = userChannel as { close?: () => Promise<void> }
      if (typeof maybeUserChannel.close === "function") await maybeUserChannel.close()
    }
    const maybeChat = chatService as { close?: () => Promise<void> }
    if (typeof maybeChat.close === "function") {
      await maybeChat.close()
    }
    if (pushSender) {
      const maybePush = pushSender as { close?: () => Promise<void> }
      if (typeof maybePush.close === "function") await maybePush.close()
    }
    if (sharedPubSub) {
      await sharedPubSub.close()
      sharedPubSub = undefined
    }
    if (redis) {
      await redis.quit().catch(() => redis?.disconnect())
      redis = undefined
      redisCounters = undefined
      cacheClient = undefined
      feedPresence = undefined
      redisByteMeter = undefined
    }
    if (dbHandle) {
      await dbHandle.close()
      dbHandle = undefined
    }
    dmRepo = undefined
    blocksRepo = undefined
    volunteerHoursRepo = undefined
    certificateRepo = undefined
    postRepo = undefined
    affiliationLoader = undefined
    postService = undefined
    notificationService = undefined
    userChannel = undefined
    pushSender = undefined
  }

  return {
    env,
    csrf,
    storage,
    inboundStorage,
    developmentOnlyLocalObjectStores: localObjectStores,
    mailer,
    smsSender,
    inboundMail,
    geocoder,
    streetReverseGeocode,
    jurisdictionLookup,
    chatService,
    get userChannel() {
      return getUserChannel()
    },
    get pushSender() {
      return getPushSender()
    },
    routingProvider,
    abuseChecks,
    jobs,
    get dbHandle() {
      return dbHandle
    },
    get redis() {
      return redis
    },
    usesRealDb: env.DATABASE_URL.length > 0,
    usesRealRedis: env.REDIS_URL.length > 0,
    getDb,
    getRedis,
    getDmRepo,
    getBlocksRepo,
    getVolunteerHoursRepo,
    getCertificateRepo,
    getAffiliationLoader,
    getPostRepo,
    getPostService,
    getNotificationService,
    getCounterStore,
    getCache,
    getByteMeter,
    getTicketTokenSigner,
    close,
  }
}

export async function assertRedisReachable(container: Container): Promise<void> {
  if (container.env.NODE_ENV !== "production" || container.env.REDIS_URL.length === 0) return
  let pong: string
  try {
    pong = await container.getRedis().ping()
  } catch (err) {
    throw new Error(
      `Redis is unreachable at boot (REDIS_URL): rate limiting, OTP throttles and sessions all depend on ` +
        `it, so refusing to serve. Cause: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  if (pong !== "PONG") {
    throw new Error(
      `Redis PING returned ${JSON.stringify(pong)} instead of PONG; refusing to serve.`,
    )
  }
}

function buildPushConfig(env: Env) {
  const config: import("./adapters/push-sender.js").PushSenderConfig = {}
  if (env.APNS_KEY_ID && env.APNS_TEAM_ID && env.APNS_PRIVATE_KEY && env.APNS_BUNDLE_ID) {
    config.apns = {
      keyId: env.APNS_KEY_ID,
      teamId: env.APNS_TEAM_ID,
      privateKey: env.APNS_PRIVATE_KEY,
      bundleId: env.APNS_BUNDLE_ID,
      // App Store and TestFlight builds register production-gateway tokens; only Xcode debug builds
      // need the sandbox, so an unset flag must not route real devices to it.
      production: env.APNS_PRODUCTION ?? true,
    }
  }
  if (env.FCM_SERVICE_ACCOUNT_JSON) {
    try {
      JSON.parse(env.FCM_SERVICE_ACCOUNT_JSON)
    } catch {
      throw new Error("FCM_SERVICE_ACCOUNT_JSON is not valid JSON")
    }
    config.fcm = {
      serviceAccountJson: env.FCM_SERVICE_ACCOUNT_JSON,
      ...(env.FCM_PROJECT_ID !== undefined ? { projectId: env.FCM_PROJECT_ID } : {}),
    }
  }
  if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT) {
    config.webPush = {
      publicKey: env.VAPID_PUBLIC_KEY,
      privateKey: env.VAPID_PRIVATE_KEY,
      subject: env.VAPID_SUBJECT,
    }
  }
  if (env.EXPO_ACCESS_TOKEN) {
    config.expo = { accessToken: env.EXPO_ACCESS_TOKEN }
  }
  return config
}
