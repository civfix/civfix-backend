import { FakeStorage, FakeAbuseChecks } from "@civfix/shared/fakes"
import type { AbuseChecks, Storage } from "@civfix/shared/interfaces"
import type { FindPhashDuplicateFn } from "@civfix/api/adapters/abuse-checks"
import { makeDb, type DbHandle } from "@civfix/api/db"
import { makeDrizzleMediaWorkerRepo, type MediaWorkerRepo } from "@civfix/api/media-repo"
import { makeDrizzleAnonHoldReleaseRepo } from "@civfix/api/anon-hold-repo"
import type { AnonHoldReleaseRepo } from "@civfix/api/anon-hold-release"
import { R2Storage } from "@civfix/api/adapters/storage"
import { LOCAL_STORAGE_DEV_SIGNING_KEY, LocalDiskStorage } from "@civfix/api/adapters/storage-local"
import { captureError, initErrorReporting, flushErrorReporting } from "@civfix/api/errors"
import { parseBool } from "@civfix/api/env-parsers"
import { assertRealSeamInProd, loadLimits, type WorkerLimits } from "./config.js"
import { makeDownloader, type DownloadFn } from "./download.js"
import type { JobLogFn } from "./jobs/obs.js"

export interface WorkerSeams {
  storage: Storage
  publicMediaBase: string | undefined
  inboundStorage: Storage | undefined
  abuseChecks: AbuseChecks
  limits: WorkerLimits
  download: DownloadFn
  dbHandle: DbHandle | undefined
  repo: MediaWorkerRepo | undefined
  anonHoldRepo: AnonHoldReleaseRepo | undefined
  findPhashDuplicate: FindPhashDuplicateFn | undefined
  report: (err: unknown, context?: Record<string, unknown>) => void
  close(): Promise<void>
}

function useFake(source: NodeJS.ProcessEnv, key: string): boolean {
  const isProd = source.NODE_ENV === "production"
  return parseBool(source[key], !isProd)
}

export interface BuildSeamsOptions {
  log?: JobLogFn
}

// The worker has no pino instance of its own; adapters it builds write to this one channel so a caller
// can redirect every seam's output at once instead of each adapter choosing its own console fallback.
const defaultSeamLog: JobLogFn = (line, extra) => console.warn(line, extra ?? {})

const DEFAULT_NODE_ENV = "development"
const DEFAULT_SERVICE_VERSION = "0.0.0"

export async function makeSeams(
  source: NodeJS.ProcessEnv = process.env,
  options: BuildSeamsOptions = {},
): Promise<WorkerSeams> {
  const limits = loadLimits(source)
  const log = options.log ?? defaultSeamLog

  const fakeStorage = useFake(source, "USE_FAKE_STORAGE")
  const fakeAbuse = useFake(source, "USE_FAKE_ABUSE_NSFW")

  assertRealSeamInProd(
    source,
    "USE_FAKE_STORAGE",
    fakeStorage,
    "the worker reads the API's uploaded bytes from R2; a fake in-memory store is empty in prod and " +
      "would lose media. Provide the R2 credentials (R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / " +
      "R2_SECRET_ACCESS_KEY / R2_BUCKET).",
  )

  await initErrorReporting({
    ...(source.GLITCHTIP_DSN ? { dsn: source.GLITCHTIP_DSN } : {}),
    environment: source.NODE_ENV ?? DEFAULT_NODE_ENV,
    release: `media-worker@${source.SERVICE_VERSION ?? DEFAULT_SERVICE_VERSION}`,
  })

  const localStorageDir = (source.LOCAL_STORAGE_DIR ?? "").trim()
  const storage: Storage =
    localStorageDir.length > 0
      ? localDiskStorage(source, localStorageDir, "media")
      : fakeStorage
        ? new FakeStorage()
        : r2Storage(source, () => req(source, "R2_BUCKET"))

  const { dbHandle, repo, anonHoldRepo } = makeDbSeams(source)

  const findPhashDuplicate: FindPhashDuplicateFn | undefined = repo?.findPhashDuplicate

  const abuseChecks: AbuseChecks = fakeAbuse
    ? new FakeAbuseChecks()
    : await makeRealAbuseChecks(source, limits, findPhashDuplicate, log)

  const download = makeDownloader(storage)

  const inboundStorage = makeInboundStorage(source, {
    storage,
    localStorageDir,
    usesR2: localStorageDir.length === 0 && !fakeStorage,
  })

  const publicMediaBaseRaw = (source.R2_PUBLIC_BASE ?? "").trim()

  return {
    storage,
    publicMediaBase: publicMediaBaseRaw.length > 0 ? publicMediaBaseRaw : undefined,
    inboundStorage,
    abuseChecks,
    limits,
    download,
    dbHandle,
    repo,
    anonHoldRepo,
    findPhashDuplicate,
    report: captureError,
    async close(): Promise<void> {
      if (dbHandle) await dbHandle.close()
      await flushErrorReporting()
    },
  }
}

function localDiskStorage(
  source: NodeJS.ProcessEnv,
  rootDirectory: string,
  namespace: "media" | "inbound",
): LocalDiskStorage {
  return new LocalDiskStorage({
    rootDirectory,
    namespace,
    publicApiUrl: req(source, "PUBLIC_API_URL"),
    signingKey: (source.LOCAL_STORAGE_SIGNING_KEY ?? "").trim() || LOCAL_STORAGE_DEV_SIGNING_KEY,
    nodeEnv: source.NODE_ENV ?? DEFAULT_NODE_ENV,
  })
}

// The bucket is resolved after the credentials so a missing credential is the error reported first.
function r2Storage(source: NodeJS.ProcessEnv, bucket: () => string): R2Storage {
  return new R2Storage({
    accountId: req(source, "R2_ACCOUNT_ID"),
    accessKeyId: req(source, "R2_ACCESS_KEY_ID"),
    secretAccessKey: req(source, "R2_SECRET_ACCESS_KEY"),
    bucket: bucket(),
  })
}

function makeDbSeams(
  source: NodeJS.ProcessEnv,
): Pick<WorkerSeams, "dbHandle" | "repo" | "anonHoldRepo"> {
  const databaseUrl = (source.DATABASE_URL ?? "").trim()
  if (databaseUrl) {
    const dbHandle = makeDb(databaseUrl)
    return {
      dbHandle,
      repo: makeDrizzleMediaWorkerRepo(dbHandle.db, dbHandle.sql),
      anonHoldRepo: makeDrizzleAnonHoldReleaseRepo(dbHandle.sql),
    }
  }
  if (source.NODE_ENV === "production") {
    throw new Error("media-worker: DATABASE_URL is required in production to persist media results")
  }
  return { dbHandle: undefined, repo: undefined, anonHoldRepo: undefined }
}

function makeInboundStorage(
  source: NodeJS.ProcessEnv,
  media: { storage: Storage; localStorageDir: string; usesR2: boolean },
): Storage | undefined {
  const inboundBucket =
    (source.R2_INBOUND_BUCKET ?? "").trim() ||
    ((source.R2_PUBLIC_BASE ?? "").trim().length === 0 ? (source.R2_BUCKET ?? "").trim() : "")
  if (media.usesR2 && inboundBucket.length === 0) {
    console.warn(
      "media-worker: no R2_INBOUND_BUCKET (and R2_PUBLIC_BASE is set), so the inbound-email retention " +
        "lane is DISABLED and archived inbound_emails rows are kept. Set R2_INBOUND_BUCKET to the same " +
        "bucket the API writes inbound mail to.",
    )
  }
  if (media.usesR2) {
    return inboundBucket.length === 0 ? undefined : r2Storage(source, () => inboundBucket)
  }
  if (media.localStorageDir.length > 0) {
    return localDiskStorage(source, media.localStorageDir, "inbound")
  }
  return media.storage
}

function req(source: NodeJS.ProcessEnv, key: string): string {
  const v = (source[key] ?? "").trim()
  if (!v) throw new Error(`media-worker: ${key} is required when its real seam is enabled`)
  return v
}

async function makeRealAbuseChecks(
  source: NodeJS.ProcessEnv,
  limits: WorkerLimits,
  findPhashDuplicate: FindPhashDuplicateFn | undefined,
  log: JobLogFn,
): Promise<AbuseChecks> {
  const { RealAbuseChecks } = await import("@civfix/api/adapters/abuse-checks")
  const { perceptualHash } = await import("./sandbox/phash.js")

  return new RealAbuseChecks({
    ...(source.CF_TURNSTILE_SECRET ? { turnstileSecret: source.CF_TURNSTILE_SECRET } : {}),
    useRealNsfw: parseBool(source.USE_REAL_NSFW, false),
    perceptualHash: (bytes: Uint8Array) => perceptualHash(bytes, limits),
    ...(findPhashDuplicate ? { findPhashDuplicate } : {}),
    log,
  })
}
