/**
 * Dependency-injection container.
 *
 * This is the ONE place where real-vs-fake seam selection happens. The app depends only on the seam
 * interfaces, never on a vendor SDK or a fake directly. The container holds 10 of the shared seam
 * interfaces (Storage ×2 — main + inbound buffer, Mailer, InboundMail, Geocoder, ChatService,
 * UserChannel, PushSender, AbuseChecks, Jobs) PLUS the backend-local `JurisdictionLookup` seam (a
 * write-time Census fallback, not part of the shared set). Selection rules:
 *
 *   storage      REAL R2Storage          unless env.USE_FAKE_STORAGE      -> FakeStorage
 *   mailer       REAL OciMailer          unless env.USE_FAKE_MAILER       -> FakeMailer
 *   pushSender   REAL MultiPushSender     unless env.USE_FAKE_PUSH         -> FakePushSender
 *   abuseChecks  REAL RealAbuseChecks     unless env.USE_FAKE_ABUSE_NSFW   -> FakeAbuseChecks
 *   chatService  REAL WsChatService       unless env.USE_FAKE_CHAT         -> FakeChatService
 *   userChannel  REAL RedisUserChannel    unless env.USE_FAKE_USER_CHANNEL -> FakeUserChannel
 *   jobs         REAL PgBossJobs          unless env.USE_FAKE_JOBS         -> FakeJobs
 *   geocoder     REAL TigerGeocoder       (no flag; fake outside production)
 *   jurisdictionLookup REAL CensusJurisdictionLookup (no flag; fake outside production)
 *   inboundMail  REAL CfInboundMail       (no flag; fake outside production)
 *   routingProvider REAL HttpRoutingProvider (no flag; fake outside production)
 *
 * SEAM-FLAG CARVE-OUT: geocoder/jurisdictionLookup/inboundMail/routingProvider intentionally have NO
 * `USE_FAKE_*` flag — they gate on `NODE_ENV === "production"` (real) vs everything else (fake). They
 * are read-only network lookups with a benign no-op fake (null/empty), so a dev never needs to
 * exercise the real path locally; the 7 flagged seams are the ones with stateful local infra
 * (DB/Redis/storage) worth toggling. NOTE: `routingProvider` is a Phase-2 scaffold (HttpRoutingProvider
 * throws NOT_IMPL) wired but not yet consumed — kept for the seam contract + the di test until a real
 * routing seam lands.
 *
 * db/redis handles are created LAZILY: the drivers do not connect until first use, and a handle is
 * only created when something needs it (a real seam, or readiness checks). In all-fakes dev/test mode
 * they stay undefined, so the server boots with no DATABASE_URL/REDIS_URL.
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
import { makeMediaPresigner } from "./services/media-presign.js"
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
  /**
   * Write-time jurisdiction fallback (US Census Geocoder) consulted on a local PostGIS miss; best-effort.
   * Fake (returns null) outside production, so dev/test reproduce today's local-only behavior offline.
   */
  readonly jurisdictionLookup: JurisdictionLookup
  readonly chatService: ChatService
  /** Per-user realtime invalidate-signal channel (notifications / thread-unread). Best-effort. */
  readonly userChannel: UserChannel
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
        dmRepo = makeDrizzleDmRepository(getDb().sql, presignMedia)
      }
    }
    return dmRepo
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

  // Media presigner over the storage seam, shared by the chat + dm repos so a message's attachments project
  // as presigned, status-"ready" MediaDTOs (same signer the report/discussion read paths use). Declared
  // after `storage`; `getDmRepo` (above) is lazy, so its closure over this resolves by call time.
  const presignMedia = makeMediaPresigner(storage)

  // Inbound-mail storage (the catch-all email buffer).
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

  // TigerGeocoder reads the jurisdictions PostGIS table; the lazy `getSql` thunk means constructing it
  // here does NOT open a DB connection (the driver connects on first query).
  const geocoder: Geocoder =
    env.NODE_ENV === "production"
      ? new TigerGeocoder({ getSql: () => getDb().sql })
      : new FakeGeocoder()

  // Reaches the US Census Geographies API on a local resolver miss; the fake returns null so dev/test
  // reproduce today's local-only behavior offline. Holds no resources (fetch + AbortController are
  // per-call), so it needs no close() handling.
  const jurisdictionLookup: JurisdictionLookup =
    env.NODE_ENV === "production"
      ? new CensusJurisdictionLookup({
          baseUrl: env.CENSUS_GEOCODER_URL,
          timeoutMs: env.CENSUS_GEOCODER_TIMEOUT_MS,
        })
      : new FakeJurisdictionLookup()

  const inboundMail: InboundMail =
    env.NODE_ENV === "production"
      ? new CfInboundMail(
          env.CF_EMAIL_WEBHOOK_SECRET !== undefined
            ? { webhookSecret: env.CF_EMAIL_WEBHOOK_SECRET }
            : {},
        )
      : new FakeInboundMail()

  // Phase-2 scaffold (HttpRoutingProvider throws NOT_IMPL); nothing consumes it yet — kept for the seam
  // contract until a real routing seam lands (see the header note).
  const routingProvider: RoutingProvider =
    env.NODE_ENV === "production" ? new HttpRoutingProvider() : new FakeRoutingProvider()

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

  // ONE RedisChatPubSub multiplexes chat:* (rooms) AND user:* (per-user signals) over a single duplicated
  // subscriber connection, so a worker holding a user's socket does not open a second Redis subscriber.
  // Built lazily + memoized: it only exists when a REAL chat service or a REAL user channel needs it.
  // CLOSE OWNERSHIP: the CONTAINER owns sharedPubSub.close() (see close() below); the adapters only
  // unsubscribe their own channels.
  let sharedPubSub: RedisChatPubSub | undefined
  function getSharedPubSub(): RedisChatPubSub {
    if (!sharedPubSub) sharedPubSub = new RedisChatPubSub(getRedis())
    return sharedPubSub
  }

  // REAL chat: persistence via the Drizzle chat repo + fan-out via the shared Redis pub/sub, both
  // injected so the realtime/Redis SDKs stay confined to the adapter and tests can swap fakes.
  const chatService: ChatService = env.USE_FAKE_CHAT
    ? new FakeChatService()
    : new WsChatService({
        repo: makeDrizzleChatRepository(getDb().sql, presignMedia),
        pubsub: getSharedPubSub(),
      })

  // REAL user channel: per-user invalidate-signal fan-out over the SAME shared Redis pub/sub as chat.
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
    // Stop jobs first so nothing new enqueues, then close infra handles. start()/stop() are not on the
    // Jobs interface (lifecycle is adapter-specific), so duck-type them.
    const maybePgBoss = jobs as { stop?: () => Promise<void> }
    if (typeof maybePgBoss.stop === "function") {
      await maybePgBoss.stop()
    }
    // Adapters only UNSUBSCRIBE their own channels in close(); the container OWNS the shared pub/sub
    // connection lifecycle (below). This removes the prior fragile arrangement where exactly one of the
    // two adapters had to own pubsub.close() (a refactor away from a leaked subscriber connection).
    const maybeUserChannel = userChannel as { close?: () => Promise<void> }
    if (typeof maybeUserChannel.close === "function") {
      await maybeUserChannel.close()
    }
    const maybeChat = chatService as { close?: () => Promise<void> }
    if (typeof maybeChat.close === "function") {
      await maybeChat.close()
    }
    // Tear down any long-lived push vendor connections (APNs provider, FCM app). Duck-typed: close() is
    // optional on the PushSender seam (MultiPushSender exposes it; FakePushSender does not).
    const maybePush = pushSender as { close?: () => Promise<void> }
    if (typeof maybePush.close === "function") {
      await maybePush.close()
    }
    // Container-owned: close the shared pub/sub subscriber connection if it was ever created, regardless
    // of which seam (real/fake) triggered its creation. Idempotent on the adapter side.
    if (sharedPubSub) {
      await sharedPubSub.close()
      sharedPubSub = undefined
    }
    if (redis) {
      // Graceful drain (quit) rather than abrupt disconnect; fall back to disconnect if quit rejects
      // (e.g. the client never connected).
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
    // Fail fast at boot on a malformed service-account blob rather than at the first push send (a bad
    // FCM_SERVICE_ACCOUNT_JSON would otherwise surface only when the first Android notification is
    // attempted, long after deploy).
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
  return config
}
