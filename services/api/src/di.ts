/**
 * Dependency-injection container.
 *
 * This is the ONE place where real-vs-fake seam selection happens. The rest of the app depends only
 * on the 9 interface types from `@civfix/shared/interfaces`; it never imports a vendor SDK or a fake
 * directly. Selection rules:
 *
 *   storage      REAL R2Storage          unless env.USE_FAKE_STORAGE      -> FakeStorage
 *   mailer       REAL OciMailer          unless env.USE_FAKE_MAILER       -> FakeMailer
 *   pushSender   REAL MultiPushSender     unless env.USE_FAKE_PUSH         -> FakePushSender
 *   abuseChecks  REAL RealAbuseChecks     unless env.USE_FAKE_ABUSE_NSFW   -> FakeAbuseChecks
 *   chatService  REAL WsChatService       unless env.USE_FAKE_CHAT         -> FakeChatService
 *   jobs         REAL PgBossJobs          unless env.USE_FAKE_JOBS         -> FakeJobs
 *   geocoder     REAL TigerGeocoder       (no flag; falls back to fake outside production)
 *   inboundMail  REAL CfInboundMail       (no flag; falls back to fake outside production)
 *   routing      REAL HttpRoutingProvider (no flag; falls back to fake outside production)
 *
 * db/redis handles are created LAZILY: the underlying drivers do not connect until first use, and a
 * handle is only created when something needs it (a real seam, or readiness checks). In all-fakes
 * dev/test mode they stay undefined, so the server boots with no DATABASE_URL/REDIS_URL.
 *
 * Seams whose REAL impls need db/redis (chat, push) force creation of the relevant handle here; jobs
 * (PgBossJobs) takes the connection string and opens pg-boss lazily in start() (called from the server
 * before it listens). chat, push, and jobs are all fully implemented now (no scaffold throws remain).
 */

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
} from "@civfix/shared/fakes"

import type { Env } from "./env.js"
import { makeDb, type DbHandle } from "./db/client.js"
import { makeRedis, type RedisClient } from "./adapters/redis.js"

import { R2Storage } from "./adapters/storage.r2.js"
import { OciMailer } from "./adapters/mailer.oci.js"
import { CfInboundMail } from "./adapters/inbound-mail.cf.js"
import { TigerGeocoder } from "./adapters/geocoder.tiger.js"
import { WsChatService } from "./adapters/chat-service.ws.js"
import { RedisChatPubSub } from "./adapters/chat-pubsub.js"
import { makeDrizzleChatRepository } from "./services/chat-repository.drizzle.js"
import { makeDrizzleDmRepository, type DmRepository } from "./services/dm-repository.drizzle.js"
import {
  makeDrizzleBlocksRepository,
  type BlocksRepository,
} from "./services/blocks-repository.drizzle.js"
import {
  InMemoryBlocksRepository,
  InMemoryDmRepository,
} from "./services/dm-repository.memory.js"
import { MultiPushSender } from "./adapters/push-sender.js"
import { HttpRoutingProvider } from "./adapters/routing-provider.js"
import { RealAbuseChecks } from "./adapters/abuse-checks.js"
import { PgBossJobs } from "./adapters/jobs.pgboss.js"

/**
 * The application container. All getters are eager (constructed in `buildContainer`) except db/redis
 * which are lazy handles. `close()` tears down whatever was actually created.
 */
export interface Container {
  readonly env: Env

  readonly storage: Storage
  /** Storage for the inbound-mail buffer (R2_INBOUND_BUCKET, else R2_BUCKET). See buildContainer. */
  readonly inboundStorage: Storage
  readonly mailer: Mailer
  readonly inboundMail: InboundMail
  readonly geocoder: Geocoder
  readonly chatService: ChatService
  readonly pushSender: PushSender
  readonly routingProvider: RoutingProvider
  readonly abuseChecks: AbuseChecks
  readonly jobs: Jobs

  /** Lazily-created DB handle. Undefined until something needs the database. */
  readonly dbHandle: DbHandle | undefined
  /** Lazily-created Redis client. Undefined until something needs Redis. */
  readonly redis: RedisClient | undefined

  /** Force-create (memoized) the DB handle. Use in readiness checks / real seams. */
  getDb(): DbHandle
  /** Force-create (memoized) the Redis client. Use in readiness checks / real seams. */
  getRedis(): RedisClient

  /**
   * Memoized DM repository, shared by the WS gateway, the threads UNION, and the dm routes. Drizzle-backed
   * in production; an in-memory process-local impl in the all-fakes dev path (USE_FAKE_CHAT, no DB).
   */
  getDmRepo(): DmRepository
  /**
   * Memoized blocks repository, shared by the WS gateway (block gate), the threads UNION, and the
   * block/search routes. Drizzle-backed in production; in-memory in the all-fakes dev path.
   */
  getBlocksRepo(): BlocksRepository

  /** Tear down created resources (db pool, redis, jobs). Safe to call once at shutdown. */
  close(): Promise<void>
}

/**
 * Build the container for the given env. Pure wiring: constructs fakes or real adapters per flags.
 */
export function buildContainer(env: Env): Container {
  // Lazy singletons for infra handles.
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

  // DM + blocks repos (memoized singletons). In the all-fakes dev path they are in-memory and the blocks
  // repo is wired into the dm repo so the threads UNION excludes blocked-either-way threads; in production
  // they are Drizzle-backed over the lazily-created DB handle. Built on first use so merely constructing
  // the container opens no DB connection.
  let dmRepo: DmRepository | undefined
  let blocksRepo: BlocksRepository | undefined
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
        dmRepo = makeDrizzleDmRepository(getDb().sql)
      }
    }
    return dmRepo
  }

  // ----- storage -----
  const storage: Storage = env.USE_FAKE_STORAGE
    ? new FakeStorage()
    : new R2Storage({
        accountId: env.R2_ACCOUNT_ID,
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
        bucket: env.R2_BUCKET,
        ...(env.R2_PUBLIC_BASE !== undefined ? { publicBase: env.R2_PUBLIC_BASE } : {}),
      })

  // ----- inbound-mail storage (the catch-all email buffer) -----
  // The Cloudflare Email Worker writes raw .eml + extracted attachments to a (possibly DEDICATED) bucket;
  // the inbound webhook + sweep read/delete/presign from the SAME bucket. Defaults to R2_BUCKET when
  // R2_INBOUND_BUCKET is unset (single-bucket deploy). No publicBase: inbox attachment links are signed
  // GET URLs (the media public domain does not front this bucket). In all-fakes dev the inbound flow
  // shares the one in-memory FakeStorage so a dev sweep/webhook sees what a (hypothetical) put wrote.
  const inboundStorage: Storage = env.USE_FAKE_STORAGE
    ? storage
    : new R2Storage({
        accountId: env.R2_ACCOUNT_ID,
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
        bucket: env.R2_INBOUND_BUCKET ?? env.R2_BUCKET,
      })

  // ----- mailer -----
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

  // ----- geocoder (no flag; fake outside production) -----
  // REAL TigerGeocoder reads the jurisdictions PostGIS table; it takes a lazy `getSql` thunk so simply
  // constructing it here does NOT open a DB connection (the driver connects on first query).
  const geocoder: Geocoder =
    env.NODE_ENV === "production"
      ? new TigerGeocoder({ getSql: () => getDb().sql })
      : new FakeGeocoder()

  // ----- inbound mail (no flag; fake outside production) -----
  const inboundMail: InboundMail =
    env.NODE_ENV === "production"
      ? new CfInboundMail(
          env.CF_EMAIL_WEBHOOK_SECRET !== undefined
            ? { webhookSecret: env.CF_EMAIL_WEBHOOK_SECRET }
            : {},
        )
      : new FakeInboundMail()

  // ----- routing provider (no flag; fake outside production) -----
  const routingProvider: RoutingProvider =
    env.NODE_ENV === "production" ? new HttpRoutingProvider() : new FakeRoutingProvider()

  // ----- abuse checks (NSFW gated by USE_FAKE_ABUSE_NSFW) -----
  // The API only uses verifyTurnstile + gpsPlausible from this seam; pHash/isNearDuplicate/nsfwScore are
  // worker-only. We still pass USE_REAL_NSFW for symmetry. With no model wired and the flag off (the
  // default), nsfwScore is benign and nothing here throws. The worker wires the real perceptual hasher +
  // near-duplicate lookup separately (see media-worker/src/seams.ts).
  const abuseChecks: AbuseChecks = env.USE_FAKE_ABUSE_NSFW
    ? new FakeAbuseChecks()
    : new RealAbuseChecks({
        ...(env.CF_TURNSTILE_SECRET !== undefined
          ? { turnstileSecret: env.CF_TURNSTILE_SECRET }
          : {}),
        useRealNsfw: env.USE_REAL_NSFW,
      })

  // ----- chat service (REAL needs db + redis) -----
  // REAL: persistence via the Drizzle chat repo (over the raw sql tag) + fan-out via Redis pub/sub. Both
  // are injected so the realtime/Redis SDKs stay confined to the adapter and tests can swap fakes.
  const chatService: ChatService = env.USE_FAKE_CHAT
    ? new FakeChatService()
    : new WsChatService({
        repo: makeDrizzleChatRepository(getDb().sql),
        pubsub: new RedisChatPubSub(getRedis()),
      })

  // ----- push sender (REAL needs db) -----
  const pushSender: PushSender = env.USE_FAKE_PUSH
    ? new FakePushSender()
    : new MultiPushSender({ db: getDb().db, config: buildPushConfig(env) })

  // ----- jobs (REAL needs the pgboss connection string) -----
  const jobs: Jobs = env.USE_FAKE_JOBS
    ? new FakeJobs()
    : new PgBossJobs({ connectionString: env.DATABASE_URL })

  async function close(): Promise<void> {
    // Stop jobs first so nothing new enqueues, then close infra handles.
    const maybePgBoss = jobs as { stop?: () => Promise<void> }
    if (typeof maybePgBoss.stop === "function") {
      await maybePgBoss.stop()
    }
    // Tear down the chat service's pub/sub subscriptions (the duplicated Redis subscriber connection)
    // before closing the shared redis handle below.
    const maybeChat = chatService as { close?: () => Promise<void> }
    if (typeof maybeChat.close === "function") {
      await maybeChat.close()
    }
    if (redis) {
      redis.disconnect()
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
    chatService,
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
    close,
  }
}

/** Assemble the optional per-platform push config from env (only present platforms included). */
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
  return config
}
