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
import { makeDrizzleDmRepository } from "./services/dm-repository.drizzle.js"
import type { DmRepository } from "./services/dm-repository.js"
import type { BlocksRepository } from "./services/blocks-repository.js"
import type { PostRepository } from "./services/post-repository.js"
import { makeMediaPresigner, makePrivateMediaPresigner } from "./services/media-presign.js"
import { makeDrizzleBlocksRepository } from "./services/blocks-repository.drizzle.js"
import { makeDrizzleVolunteerHoursRepository } from "./services/volunteer-hours-repository.drizzle.js"
import type { VolunteerHoursRepository } from "./services/volunteer-hours-repository.js"
import type { CertificateRepository } from "./services/certificate-repository.js"
import { makeDrizzleCertificateRepository } from "./services/certificate-repository.drizzle.js"
import { makeDrizzlePostRepository } from "./services/post-repository.drizzle.js"
import { makePostService, type PostService } from "./services/post-service.js"
import { makeFeedPresence } from "./services/feed-presence.js"
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
import { MultiPushSender, type PushSenderConfig } from "./adapters/push-sender.js"
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

interface Lazy<T> {
  get(): T
  readonly current: T | undefined
  reset(): void
}

function lazy<T>(create: () => T): Lazy<T> {
  let value: T | undefined
  return {
    get: () => (value ??= create()),
    get current() {
      return value
    },
    reset: () => {
      value = undefined
    },
  }
}

// Adapters are built before makeServer hands over its logger, so they get a forwarder that resolves
// the server logger at call time instead of capturing a console fallback at construction.
function forwardingLogger(resolve: () => NotificationLogger | undefined): AdapterLogger {
  const forward = (level: "warn" | "error", obj: unknown, msg: string | undefined): void => {
    const target = resolve()
    if (target !== undefined) target[level](obj, msg)
    else PRE_SERVER_LOGGER[level](obj, msg)
  }
  return {
    warn: (obj, msg) => forward("warn", obj, msg),
    error: (obj, msg) => forward("error", obj, msg),
  }
}

interface Connections {
  getDb(): DbHandle
  getRedis(): RedisClient
  readonly dbHandle: DbHandle | undefined
  readonly redis: RedisClient | undefined
  markClosed(): void
  closeRedis(): Promise<boolean>
  closeDb(): Promise<void>
}

function makeConnections(env: Env, logger: () => NotificationLogger | undefined): Connections {
  let dbHandle: DbHandle | undefined
  let redis: RedisClient | undefined
  let closed = false
  // A getter reached after shutdown would otherwise open a fresh pool that nothing ever closes.
  function assertOpen(): void {
    if (closed) throw new Error("DI container is closed")
  }
  return {
    getDb() {
      assertOpen()
      dbHandle ??= makeDb(env.DATABASE_URL)
      return dbHandle
    },
    getRedis() {
      assertOpen()
      redis ??= makeRedis(env.REDIS_URL, {
        onError: (err) => logger()?.error({ err, component: "redis" }, "redis client error"),
      })
      return redis
    },
    get dbHandle() {
      return dbHandle
    },
    get redis() {
      return redis
    },
    markClosed() {
      closed = true
    },
    async closeRedis() {
      if (!redis) return false
      await redis.quit().catch(() => redis?.disconnect())
      redis = undefined
      return true
    },
    async closeDb() {
      if (!dbHandle) return
      await dbHandle.close()
      dbHandle = undefined
    },
  }
}

interface StorageSeams {
  storage: Storage
  inboundStorage: Storage
  localObjectStores: readonly LocalDiskStorage[] | undefined
}

function makeStorageSeams(env: Env): StorageSeams {
  const localStorageDir = env.LOCAL_STORAGE_DIR
  if (localStorageDir !== undefined) {
    const media = makeLocalDiskStorage(env, localStorageDir, "media")
    const inbound = makeLocalDiskStorage(env, localStorageDir, "inbound")
    return { storage: media, inboundStorage: inbound, localObjectStores: [media, inbound] }
  }
  if (env.USE_FAKE_STORAGE) {
    const storage = new FakeStorage()
    return { storage, inboundStorage: storage, localObjectStores: undefined }
  }

  const storage = new R2Storage({
    ...r2Credentials(env),
    bucket: env.R2_BUCKET,
    ...(env.R2_PUBLIC_BASE !== undefined ? { publicBase: env.R2_PUBLIC_BASE } : {}),
  })
  const inboundBucket =
    env.R2_INBOUND_BUCKET ?? (env.R2_PUBLIC_BASE === undefined ? env.R2_BUCKET : "")
  if (inboundBucket.length === 0) {
    throw new Error(
      "R2_INBOUND_BUCKET is required when R2_PUBLIC_BASE is set: refusing to write raw inbound email " +
        "into the public media bucket. Set a dedicated, non-public inbound bucket.",
    )
  }
  const inboundStorage = new R2Storage({ ...r2Credentials(env), bucket: inboundBucket })
  return { storage, inboundStorage, localObjectStores: undefined }
}

function r2Credentials(env: Env): {
  accountId: string
  accessKeyId: string
  secretAccessKey: string
} {
  return {
    accountId: env.R2_ACCOUNT_ID,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  }
}

function makeLocalDiskStorage(
  env: Env,
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

interface StatelessSeams {
  mailer: Mailer
  smsSender: SmsSender
  geocoder: Geocoder
  streetReverseGeocode: ReverseGeocode
  jurisdictionLookup: JurisdictionLookup
  inboundMail: InboundMail
  routingProvider: RoutingProvider
  abuseChecks: AbuseChecks
}

function makeStatelessSeams(
  env: Env,
  logger: AdapterLogger,
  getDb: () => DbHandle,
): StatelessSeams {
  const isProduction = env.NODE_ENV === "production"
  return {
    mailer: env.USE_FAKE_MAILER
      ? new FakeMailer()
      : new OciMailer({
          host: env.OCI_EMAIL_SMTP_HOST,
          port: env.OCI_EMAIL_SMTP_PORT,
          user: env.OCI_EMAIL_SMTP_USER,
          pass: env.OCI_EMAIL_SMTP_PASS,
          fromNoReply: env.MAIL_FROM_NOREPLY,
          fromOutreach: env.MAIL_FROM_OUTREACH,
          timeoutMs: env.OCI_EMAIL_SMTP_TIMEOUT_MS,
          logger,
        }),
    smsSender: env.USE_FAKE_SMS
      ? new FakeSmsSender()
      : new TwilioSmsSender({
          accountSid: env.TWILIO_ACCOUNT_SID,
          authToken: env.TWILIO_AUTH_TOKEN,
          from: env.TWILIO_SMS_FROM,
        }),
    geocoder: env.USE_FAKE_GEOCODER
      ? new FakeGeocoder()
      : new TigerGeocoder({ getSql: () => getDb().sql }),
    streetReverseGeocode: chainReverse(
      env.MAPBOX_TOKEN ? makeMapboxReverseGeocode({ token: env.MAPBOX_TOKEN }) : null,
      makePhotonReverseGeocode(),
    ),
    jurisdictionLookup: isProduction
      ? new CensusJurisdictionLookup({
          baseUrl: env.CENSUS_GEOCODER_URL,
          timeoutMs: env.CENSUS_GEOCODER_TIMEOUT_MS,
        })
      : new FakeJurisdictionLookup(),
    inboundMail: isProduction
      ? new CfInboundMail({ replyDomain: env.MAIL_REPLY_DOMAIN })
      : new FakeInboundMail(env.MAIL_REPLY_DOMAIN),
    routingProvider: isProduction ? new HttpRoutingProvider() : new FakeRoutingProvider(),
    abuseChecks: env.USE_FAKE_ABUSE_NSFW
      ? new FakeAbuseChecks()
      : new RealAbuseChecks({
          ...(env.CF_TURNSTILE_SECRET !== undefined
            ? { turnstileSecret: env.CF_TURNSTILE_SECRET }
            : {}),
          ...(env.CF_TURNSTILE_HOSTNAMES.length > 0
            ? { turnstileHostnames: env.CF_TURNSTILE_HOSTNAMES }
            : {}),
          useRealNsfw: env.USE_REAL_NSFW,
          log: (line, extra) => logger.warn(extra ?? {}, line),
        }),
  }
}

async function closeIfClosable(seam: unknown): Promise<void> {
  const closable = seam as { close?: () => Promise<void> }
  if (typeof closable.close === "function") await closable.close()
}

export function makeContainer(env: Env): Container {
  let serverLogger: NotificationLogger | undefined
  const currentLogger = (): NotificationLogger | undefined => serverLogger
  const adapterLogger = forwardingLogger(currentLogger)
  const connections = makeConnections(env, currentLogger)
  const { getDb, getRedis } = connections

  const csrf = makeCsrf(env)
  const hasDatabase = env.DATABASE_URL.length > 0

  const { storage, inboundStorage, localObjectStores } = makeStorageSeams(env)
  const presignMedia = makeMediaPresigner(storage)
  const presignPrivateMedia = makePrivateMediaPresigner(storage)
  const presignAvatar = (k: string) => storage.presignGet(k, MEDIA_GET_URL_TTL_SEC)

  const seams = makeStatelessSeams(env, adapterLogger, getDb)

  const volunteerHoursRepo = lazy(() => makeDrizzleVolunteerHoursRepository(getDb().sql))
  const certificateRepo = lazy(() => makeDrizzleCertificateRepository(getDb().sql))
  const blocksRepo = lazy<BlocksRepository>(() =>
    hasDatabase ? makeDrizzleBlocksRepository(getDb().sql) : new InMemoryBlocksRepository(),
  )
  const dmRepo = lazy<DmRepository>(() => {
    if (hasDatabase) return makeDrizzleDmRepository(getDb().sql, presignPrivateMedia)
    const blocks = blocksRepo.get()
    return new InMemoryDmRepository((a, b) => blocks.isBlockedEitherWay(a, b))
  })
  const affiliationLoader = lazy(() => makeAffiliationLoader(getDb().sql, presignAvatar))
  const postRepo = lazy(() =>
    makeDrizzlePostRepository(getDb().sql, {
      presignMedia,
      presignAvatar,
      affiliations: affiliationLoader.get(),
    }),
  )

  const cacheClient = lazy<CacheClient>(() => new RedisCacheClient(getRedis()))
  const redisCounters = lazy(() => new RedisCounterStore(getRedis()))
  const lazyCounters: CounterStore = {
    incr: (key, ttlSeconds) => redisCounters.get().incr(key, ttlSeconds),
    incrBy: (key, by, ttlSeconds) => redisCounters.get().incrBy(key, by, ttlSeconds),
    decrBy: (key, by) => redisCounters.get().decrBy(key, by),
  }
  const redisByteMeter = lazy(() => new RedisByteMeter(getRedis()))
  const lazyByteMeter: ByteMeter = {
    add: (subject, bytes) => redisByteMeter.get().add(subject, bytes),
  }
  const ticketTokenSigner = lazy(() => makeTicketTokenSigner(env.TICKET_TOKEN_SECRET.trim()))

  const feedPresence = lazy(() =>
    makeFeedPresence({
      ...(env.REDIS_URL.length > 0 ? { cache: cacheClient.get() } : {}),
      config: env.FEED_RANKING,
      ...(serverLogger !== undefined ? { logger: serverLogger } : {}),
    }),
  )

  const sharedPubSub = lazy(
    () =>
      new RedisChatPubSub(getRedis(), (err) =>
        serverLogger?.error(
          { err, component: "redis", role: "subscriber" },
          "redis subscriber error",
        ),
      ),
  )
  const userChannel = lazy<UserChannel>(() =>
    env.USE_FAKE_USER_CHANNEL
      ? new FakeUserChannel()
      : new RedisUserChannel({
          pubsub: sharedPubSub.get(),
          ...(serverLogger !== undefined ? { logger: serverLogger } : {}),
        }),
  )
  const pushSender = lazy<PushSender>(() =>
    env.USE_FAKE_PUSH
      ? new FakePushSender()
      : new MultiPushSender({
          db: getDb().db,
          config: buildPushConfig(env),
          counters: lazyCounters,
          logger: adapterLogger,
        }),
  )

  let notificationService: NotificationService | undefined
  let notificationLoggerWired = false
  // Rebuilt once when the first logger arrives, so a service built earlier without one does not keep
  // dropping delivery warnings.
  function getNotificationService(logger?: NotificationLogger): NotificationService {
    if (logger !== undefined) serverLogger ??= logger
    if (notificationService === undefined || (logger !== undefined && !notificationLoggerWired)) {
      notificationService = makeNotificationService({
        repo: makeDrizzleNotificationRepository(getDb().sql),
        pushSender: pushSender.get(),
        userChannel: userChannel.get(),
        ...(logger !== undefined ? { logger } : {}),
      })
      notificationLoggerWired = logger !== undefined
    }
    return notificationService
  }

  const postService = lazy(() =>
    makePostService({
      repo: postRepo.get(),
      sql: getDb().sql,
      notifier: getNotificationService(),
      isBlockedEitherWay: (a: string, b: string) => blocksRepo.get().isBlockedEitherWay(a, b),
      feedRanking: env.FEED_RANKING,
      feedPresence: feedPresence.get(),
      ...(env.USE_FAKE_USER_CHANNEL ? {} : { userChannel: userChannel.get() }),
    }),
  )

  const chatService: ChatService = env.USE_FAKE_CHAT
    ? new FakeChatService()
    : new WsChatService({
        repo: makeDrizzleChatRepository(getDb().sql, presignPrivateMedia),
        pubsub: sharedPubSub.get(),
        logger: adapterLogger,
      })

  const jobs: Jobs = env.USE_FAKE_JOBS
    ? new FakeJobs()
    : new PgBossJobs({ connectionString: env.DATABASE_URL, logger: adapterLogger })

  const memoized: ReadonlyArray<Lazy<unknown>> = [
    dmRepo,
    blocksRepo,
    volunteerHoursRepo,
    certificateRepo,
    postRepo,
    affiliationLoader,
    postService,
    userChannel,
    pushSender,
  ]

  async function close(): Promise<void> {
    const maybePgBoss = jobs as { stop?: () => Promise<void> }
    if (typeof maybePgBoss.stop === "function") {
      await maybePgBoss.stop()
    }
    if (userChannel.current) await closeIfClosable(userChannel.current)
    await closeIfClosable(chatService)
    if (pushSender.current) await closeIfClosable(pushSender.current)
    // Only now: a graceful jobs stop waits for running handlers, which still need the pools, and
    // whatever they opened is torn down below.
    connections.markClosed()
    if (sharedPubSub.current) {
      await sharedPubSub.current.close()
      sharedPubSub.reset()
    }
    if (await connections.closeRedis()) {
      redisCounters.reset()
      cacheClient.reset()
      feedPresence.reset()
      redisByteMeter.reset()
    }
    await connections.closeDb()
    for (const memo of memoized) memo.reset()
    notificationService = undefined
  }

  return {
    env,
    csrf,
    storage,
    inboundStorage,
    developmentOnlyLocalObjectStores: localObjectStores,
    ...seams,
    chatService,
    get userChannel() {
      return userChannel.get()
    },
    get pushSender() {
      return pushSender.get()
    },
    jobs,
    get dbHandle() {
      return connections.dbHandle
    },
    get redis() {
      return connections.redis
    },
    usesRealDb: hasDatabase,
    usesRealRedis: env.REDIS_URL.length > 0,
    getDb,
    getRedis,
    getDmRepo: dmRepo.get,
    getBlocksRepo: blocksRepo.get,
    getVolunteerHoursRepo: volunteerHoursRepo.get,
    getCertificateRepo: certificateRepo.get,
    getAffiliationLoader: affiliationLoader.get,
    getPostRepo: postRepo.get,
    getPostService: postService.get,
    getNotificationService,
    getCounterStore: () => lazyCounters,
    getCache: cacheClient.get,
    getByteMeter: () => lazyByteMeter,
    getTicketTokenSigner: ticketTokenSigner.get,
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

function buildPushConfig(env: Env): PushSenderConfig {
  const config: PushSenderConfig = {}
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
