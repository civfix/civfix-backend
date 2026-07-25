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

import type { Env } from "./env.js"
import { makeDb, type DbHandle } from "./db/client.js"
import { makeRedis, type RedisClient } from "./adapters/redis.js"

import { R2Storage } from "./adapters/storage.r2.js"
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
import {
  makeDrizzlePostRepository,
  type PostRepository,
} from "./services/post-repository.drizzle.js"
import { makePostService, type PostService } from "./services/post-service.js"
import { makeNotificationService } from "./services/notification-service.js"
import { makeDrizzleNotificationRepository } from "./services/notification-repository.drizzle.js"
import { MEDIA_GET_URL_TTL_SEC } from "./services/media-intake-service.js"
import { InMemoryBlocksRepository, InMemoryDmRepository } from "./services/dm-repository.memory.js"
import { MultiPushSender } from "./adapters/push-sender.js"
import { HttpRoutingProvider } from "./adapters/routing-provider.js"
import { RealAbuseChecks } from "./adapters/abuse-checks.js"
import { PgBossJobs } from "./adapters/jobs.pgboss.js"

export interface Container {
  readonly env: Env

  readonly storage: Storage
  readonly inboundStorage: Storage
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
  getPostRepo(): PostRepository
  getPostService(): PostService

  close(): Promise<void>
}

export function buildContainer(env: Env): Container {
  let dbHandle: DbHandle | undefined
  let redis: RedisClient | undefined

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
      const notifier = makeNotificationService({
        repo: makeDrizzleNotificationRepository(getDb().sql),
        pushSender,
        userChannel,
      })
      postService = makePostService({
        repo: getPostRepo(),
        sql: getDb().sql,
        notifier,
        isBlockedEitherWay: (a: string, b: string) => getBlocksRepo().isBlockedEitherWay(a, b),
      })
    }
    return postService
  }

  const storage: Storage = env.USE_FAKE_STORAGE
    ? new FakeStorage()
    : new R2Storage({
        accountId: env.R2_ACCOUNT_ID,
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
        bucket: env.R2_BUCKET,
        ...(env.R2_PUBLIC_BASE !== undefined ? { publicBase: env.R2_PUBLIC_BASE } : {}),
      })

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
  if (!env.USE_FAKE_STORAGE && inboundBucket.length === 0) {
    throw new Error(
      "R2_INBOUND_BUCKET is required when R2_PUBLIC_BASE is set: refusing to write raw inbound email " +
        "into the public media bucket. Set a dedicated, non-public inbound bucket.",
    )
  }
  const inboundStorage: Storage = env.USE_FAKE_STORAGE
    ? storage
    : new R2Storage({
        accountId: env.R2_ACCOUNT_ID,
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
        bucket: inboundBucket,
      })

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
    }
    if (dbHandle) {
      await dbHandle.close()
      dbHandle = undefined
    }
  }

  return {
    env,
    storage,
    inboundStorage,
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
    getPostRepo,
    getPostService,
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
