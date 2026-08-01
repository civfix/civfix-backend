import type {
  AbuseChecks,
  ChatService,
  Geocoder,
  InboundMail,
  Jobs,
  Mailer,
  PushSender,
  RoutingProvider,
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
  FakeStorage,
  FakeUserChannel,
} from "@civfix/shared/fakes"

import type { FastifyBaseLogger } from "fastify"

import type { Env } from "./env.js"
import { makeCsrf, type Csrf } from "./auth/csrf.js"
import { makeDb, type DbHandle } from "./db/client.js"
import { makeRedis, type RedisClient } from "./adapters/redis.js"

import { R2Storage } from "./adapters/storage.r2.js"
import {
  LOCAL_STORAGE_DEV_SIGNING_KEY,
  LocalDiskStorage,
  type LocalStorageNamespace,
} from "./adapters/storage.local.js"
import { OciMailer } from "./adapters/mailer.oci.js"
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
import {
  makeNotificationService,
  type NotificationService,
} from "./services/notification-service.js"
import { makeDrizzleNotificationRepository } from "./services/notification-repository.drizzle.js"
import { MEDIA_GET_URL_TTL_SEC } from "./services/media-intake-service.js"
import { RedisByteMeter, type ByteMeter } from "./services/media-byte-quota.js"
import { RedisCounterStore, type CounterStore } from "./abuse/counter-store.js"
import { InMemoryBlocksRepository, InMemoryDmRepository } from "./services/dm-repository.memory.js"
import { MultiPushSender } from "./adapters/push-sender.js"
import { HttpRoutingProvider } from "./adapters/routing-provider.js"
import { RealAbuseChecks } from "./adapters/abuse-checks.js"
import { PgBossJobs } from "./adapters/jobs.pgboss.js"

export interface Container {
  readonly env: Env

  /**
   * Session-bound CSRF (mint + verify), keyed by THIS container's env — the single instance every route
   * preHandler and every token-minting sign-in path must use. Two instances built from two envs would
   * sign with two keys and 403 every cookie mutation, so the seam is a container member rather than a
   * per-call-site factory call. See auth/csrf.ts.
   */
  readonly csrf: Csrf

  readonly storage: Storage
  readonly inboundStorage: Storage
  readonly developmentOnlyLocalObjectStores: readonly LocalDiskStorage[] | undefined
  readonly mailer: Mailer
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

  getDb(): DbHandle
  getRedis(): RedisClient

  getDmRepo(): DmRepository
  getBlocksRepo(): BlocksRepository
  getVolunteerHoursRepo(): VolunteerHoursRepository
  getCertificateRepo(): CertificateRepository
  getPostRepo(): PostRepository
  getPostService(): PostService
  getNotificationService(logger?: NotificationLogger): NotificationService
  getCounterStore(): CounterStore
  getByteMeter(): ByteMeter

  close(): Promise<void>
}

/** The slice of the server's pino instance the notification pipeline logs suppressed failures through. */
export type NotificationLogger = Pick<FastifyBaseLogger, "warn" | "error">

export function buildContainer(env: Env): Container {
  let dbHandle: DbHandle | undefined
  let redis: RedisClient | undefined

  // Bound to THIS env, once: see the `csrf` note on Container.
  const csrf = makeCsrf(env)

  function getDb(): DbHandle {
    if (!dbHandle) dbHandle = makeDb(env.DATABASE_URL)
    return dbHandle
  }
  function getRedis(): RedisClient {
    if (!redis) redis = makeRedis(env.REDIS_URL)
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
  /** Lazy + memoized, exactly like getVolunteerHoursRepo: `getDb()` must never run at mount time. */
  function getCertificateRepo(): CertificateRepository {
    if (!certificateRepo) {
      certificateRepo = makeDrizzleCertificateRepository(getDb().sql)
    }
    return certificateRepo
  }
  function getBlocksRepo(): BlocksRepository {
    if (!blocksRepo) {
      blocksRepo = env.USE_FAKE_CHAT
        ? new InMemoryBlocksRepository()
        : makeDrizzleBlocksRepository(getDb().sql)
    }
    return blocksRepo
  }
  function getDmRepo(): DmRepository {
    if (!dmRepo) {
      if (env.USE_FAKE_CHAT) {
        const blocks = getBlocksRepo()
        dmRepo = new InMemoryDmRepository((a, b) => blocks.isBlockedEitherWay(a, b))
      } else {
        dmRepo = makeDrizzleDmRepository(getDb().sql, presignPrivateMedia)
      }
    }
    return dmRepo
  }

  let postRepo: PostRepository | undefined
  function getPostRepo(): PostRepository {
    if (!postRepo) {
      postRepo = makeDrizzlePostRepository(getDb().sql, {
        presignMedia,
        presignAvatar: (k: string) => storage.presignGet(k, MEDIA_GET_URL_TTL_SEC),
      })
    }
    return postRepo
  }

  let postService: PostService | undefined
  function getPostService(): PostService {
    if (!postService) {
      postService = makePostService({
        repo: getPostRepo(),
        sql: getDb().sql,
        notifier: getNotificationService(),
        isBlockedEitherWay: (a: string, b: string) => getBlocksRepo().isBlockedEitherWay(a, b),
      })
    }
    return postService
  }

  /**
   * THE notification pipeline (in-app row + push + user-channel signal), memoized per container.
   *
   * The identical repo/pushSender/userChannel block was rebuilt by every plugin that rings a bell, so a
   * change to the notifier's dependencies meant finding every copy. Built lazily: the Drizzle repo is a
   * thin wrapper over the lazily-created `sql` tag, so merely resolving this opens no connection.
   *
   * `logger` is the server's pino instance — one per container, so it is memoized rather than rebuilt
   * per call. It is rebuilt at most ONCE more, when a logger arrives after a logger-less first caller:
   * the service is stateless, and whichever plugin happens to ring first must not silently strip the
   * logger from every suppressed-failure line for the rest of the process. Callers needing a DIFFERENT
   * logger (offline/override wiring) construct their own with makeNotificationService.
   */
  let notificationService: NotificationService | undefined
  let notificationLoggerWired = false
  function getNotificationService(logger?: NotificationLogger): NotificationService {
    if (notificationService === undefined || (logger !== undefined && !notificationLoggerWired)) {
      notificationService = makeNotificationService({
        repo: makeDrizzleNotificationRepository(getDb().sql),
        pushSender,
        userChannel,
        ...(logger !== undefined ? { logger } : {}),
      })
      notificationLoggerWired = logger !== undefined
    }
    return notificationService
  }

  /**
   * Shared Redis-backed abuse counters + upload byte meter, resolved on FIRST USE (not on first GET).
   *
   * Both are handed to services/route handlers that are rebuilt per request, and `getRedis()` THROWS on
   * an empty REDIS_URL (adapters/redis.ts) — eagerly constructing either therefore 500'd every route in
   * the plugin, including the anon-ok reads that never count anything (see the cleanups.routes 500).
   * These wrappers are inert values: the client is resolved inside `incr`/`add`, so a Redis-less boot
   * only fails the paths that actually spend budget, and those fail CLOSED rather than getting a free
   * allowance. A caller that must SKIP the cap instead (no-infra dev boot) tests `env.REDIS_URL` first.
   *
   * ADOPTERS (all of them — a route that hand-rolls its own is a bug, because close() can only reset the
   * client these wrappers hold): counters = anon.routes (anon-report caps), cleanups.routes (event
   * resource-request budget + role-change cooldown), forms.routes (home-turf per-IP/per-recipient caps);
   * byteMeter = media.routes (the daily upload byte quota).
   */
  let redisCounters: CounterStore | undefined
  const lazyCounters: CounterStore = {
    incr: (key, ttlSeconds) =>
      (redisCounters ??= new RedisCounterStore(getRedis())).incr(key, ttlSeconds),
  }
  function getCounterStore(): CounterStore {
    return lazyCounters
  }

  let redisByteMeter: ByteMeter | undefined
  const lazyByteMeter: ByteMeter = {
    add: (subject, bytes) => (redisByteMeter ??= new RedisByteMeter(getRedis())).add(subject, bytes),
  }
  function getByteMeter(): ByteMeter {
    return lazyByteMeter
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

  // H9 (batch-read half): chat, DM and group message attachments are PRIVATE. The public presigner
  // degrades to an unsigned, permanent CDN URL whenever R2_PUBLIC_BASE is set, which would leave a DM
  // photo world-readable forever to anyone who ever saw the link — no unsend, block or delete could
  // revoke it. Every message-attachment repo signs through this one instead.
  const presignPrivateMedia = makePrivateMediaPresigner(storage)

  // H10: the inbound-mail buffer (raw .eml + every emailed attachment) is private correspondence.
  //   - NEVER pass `publicBase` here, whatever R2_PUBLIC_BASE says: R2Storage returns an unsigned,
  //     permanent CDN URL for every key once a public base is set. Inbound objects are only ever reachable
  //     through a short-lived presign.
  //   - NO silent `?? env.R2_BUCKET` fallback when a public base exists. loadEnv already requires
  //     R2_INBOUND_BUCKET in that case; this is the belt-and-braces assertion so a future env change can
  //     never re-route inbound mail into the CDN-published media bucket without someone noticing.
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
      })

  const geocoder: Geocoder =
    env.NODE_ENV === "production"
      ? new TigerGeocoder({ getSql: () => getDb().sql })
      : new FakeGeocoder()

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
        // L16: bind accepted tokens to the pages that may mint them. Passed only when configured — an
        // empty list would read as "configured with nothing" and abuse-checks skips the assertion anyway,
        // but omitting it keeps the "not configured" notice the one signal that this is unset.
        ...(env.CF_TURNSTILE_HOSTNAMES.length > 0
          ? { turnstileHostnames: env.CF_TURNSTILE_HOSTNAMES }
          : {}),
        useRealNsfw: env.USE_REAL_NSFW,
      })

  let sharedPubSub: RedisChatPubSub | undefined
  function getSharedPubSub(): RedisChatPubSub {
    if (!sharedPubSub) sharedPubSub = new RedisChatPubSub(getRedis())
    return sharedPubSub
  }

  const chatService: ChatService = env.USE_FAKE_CHAT
    ? new FakeChatService()
    : new WsChatService({
        repo: makeDrizzleChatRepository(getDb().sql, presignPrivateMedia),
        pubsub: getSharedPubSub(),
      })

  const userChannel: UserChannel = env.USE_FAKE_USER_CHANNEL
    ? new FakeUserChannel()
    : new RedisUserChannel({ pubsub: getSharedPubSub(), logger: undefined })

  const pushSender: PushSender = env.USE_FAKE_PUSH
    ? new FakePushSender()
    : new MultiPushSender({ db: getDb().db, config: buildPushConfig(env) })

  const jobs: Jobs = env.USE_FAKE_JOBS
    ? new FakeJobs()
    : new PgBossJobs({ connectionString: env.DATABASE_URL })

  async function close(): Promise<void> {
    const maybePgBoss = jobs as { stop?: () => Promise<void> }
    if (typeof maybePgBoss.stop === "function") {
      await maybePgBoss.stop()
    }
    const maybeUserChannel = userChannel as { close?: () => Promise<void> }
    if (typeof maybeUserChannel.close === "function") {
      await maybeUserChannel.close()
    }
    const maybeChat = chatService as { close?: () => Promise<void> }
    if (typeof maybeChat.close === "function") {
      await maybeChat.close()
    }
    const maybePush = pushSender as { close?: () => Promise<void> }
    if (typeof maybePush.close === "function") {
      await maybePush.close()
    }
    if (sharedPubSub) {
      await sharedPubSub.close()
      sharedPubSub = undefined
    }
    if (redis) {
      await redis.quit().catch(() => redis?.disconnect())
      redis = undefined
      // Both wrappers cache the CLIENT, not the URL: dropping them here keeps a post-close reuse from
      // counting into a quit connection instead of the one a later getRedis() would create.
      redisCounters = undefined
      redisByteMeter = undefined
    }
    if (dbHandle) {
      await dbHandle.close()
      dbHandle = undefined
    }
  }

  return {
    env,
    csrf,
    storage,
    inboundStorage,
    developmentOnlyLocalObjectStores: localObjectStores,
    mailer,
    inboundMail,
    geocoder,
    streetReverseGeocode,
    jurisdictionLookup,
    chatService,
    userChannel,
    pushSender,
    routingProvider,
    abuseChecks,
    jobs,
    get dbHandle() {
      return dbHandle
    },
    get redis() {
      return redis
    },
    getDb,
    getRedis,
    getDmRepo,
    getBlocksRepo,
    getVolunteerHoursRepo,
    getCertificateRepo,
    getPostRepo,
    getPostService,
    getNotificationService,
    getCounterStore,
    getByteMeter,
    close,
  }
}

/**
 * Production boot assertion: Redis must actually answer before we start serving (H4).
 *
 * Every rate limit — the global bucket and the fail-closed auth/anon/media buckets — lives in the Redis
 * store. A misconfigured or unreachable REDIS_URL used to be invisible: the process booted, the limiter
 * store errored on each request, and the API served with either zero rate limiting (skipOnError) or a
 * blanket 503. Sessions and OTP throttles have the same dependency. So we PING once at startup and refuse
 * to come up if it fails, turning a silent security degradation into a loud, obvious deploy failure.
 *
 * No-op outside production and when REDIS_URL is empty (offline/all-fakes dev boots have no Redis).
 */
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
      production: env.APNS_PRODUCTION ?? false,
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
