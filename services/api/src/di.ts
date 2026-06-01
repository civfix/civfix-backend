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
 * Seams whose REAL impls need db/redis (chat, push, jobs) force creation of the relevant handle
 * even though the scaffold bodies throw; this keeps wiring honest for when the bodies are filled in.
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
  const geocoder: Geocoder =
    env.NODE_ENV === "production" ? new TigerGeocoder() : new FakeGeocoder()

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
  const abuseChecks: AbuseChecks = env.USE_FAKE_ABUSE_NSFW
    ? new FakeAbuseChecks()
    : new RealAbuseChecks(
        env.CF_TURNSTILE_SECRET !== undefined ? { turnstileSecret: env.CF_TURNSTILE_SECRET } : {},
      )

  // ----- chat service (REAL needs db + redis) -----
  const chatService: ChatService = env.USE_FAKE_CHAT
    ? new FakeChatService()
    : new WsChatService({ db: getDb().db, redis: getRedis() })

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
