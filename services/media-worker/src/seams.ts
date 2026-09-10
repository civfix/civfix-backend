
import { FakeStorage, FakeAbuseChecks } from "@civfix/shared/fakes"
import type { AbuseChecks, NearDuplicateResult, Storage } from "@civfix/shared/interfaces"
import type { FindPhashDuplicateFn } from "@civfix/api/adapters/abuse-checks"
import { makeDb, type DbHandle } from "@civfix/api/db"
import { makeDrizzleMediaWorkerRepo, type MediaWorkerRepo } from "@civfix/api/media-repo"
import { makeDrizzleAnonHoldReleaseRepo } from "@civfix/api/anon-hold-repo"
import type { AnonHoldReleaseRepo } from "@civfix/api/anon-hold-release"
import { R2Storage } from "@civfix/api/adapters/storage"
import {
  LOCAL_STORAGE_DEV_SIGNING_KEY,
  LocalDiskStorage,
} from "@civfix/api/adapters/storage-local"
import { captureError, initErrorReporting, flushErrorReporting } from "@civfix/api/errors"
import { assertRealSeamInProd, loadLimits, parseBool, type WorkerLimits } from "./config.js"
import { makeDownloader, type DownloadFn } from "./download.js"

export interface WorkerSeams {
  storage: Storage
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

export async function buildSeams(source: NodeJS.ProcessEnv = process.env): Promise<WorkerSeams> {
  const limits = loadLimits(source)

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
    environment: source.NODE_ENV ?? "development",
    release: "media-worker@0.0.0",
  })

  const localStorageDir = (source.LOCAL_STORAGE_DIR ?? "").trim()
  const storage: Storage =
    localStorageDir.length > 0
      ? new LocalDiskStorage({
          rootDirectory: localStorageDir,
          namespace: "media",
          publicApiUrl: req(source, "PUBLIC_API_URL"),
          signingKey:
            (source.LOCAL_STORAGE_SIGNING_KEY ?? "").trim() || LOCAL_STORAGE_DEV_SIGNING_KEY,
          nodeEnv: source.NODE_ENV ?? "development",
        })
      : fakeStorage
        ? new FakeStorage()
        : new R2Storage({
            accountId: req(source, "R2_ACCOUNT_ID"),
            accessKeyId: req(source, "R2_ACCESS_KEY_ID"),
            secretAccessKey: req(source, "R2_SECRET_ACCESS_KEY"),
            bucket: req(source, "R2_BUCKET"),
          })

  let dbHandle: DbHandle | undefined
  let repo: MediaWorkerRepo | undefined
  let anonHoldRepo: AnonHoldReleaseRepo | undefined
  const databaseUrl = (source.DATABASE_URL ?? "").trim()
  if (databaseUrl) {
    dbHandle = makeDb(databaseUrl)
    repo = makeDrizzleMediaWorkerRepo(dbHandle.db, dbHandle.sql)
    anonHoldRepo = makeDrizzleAnonHoldReleaseRepo(dbHandle.sql)
  } else if (source.NODE_ENV === "production") {
    throw new Error("media-worker: DATABASE_URL is required in production to persist media results")
  }

  const findPhashDuplicate: FindPhashDuplicateFn | undefined = dbHandle
    ? makePhashDuplicateLookup(dbHandle)
    : undefined

  const abuseChecks: AbuseChecks = fakeAbuse
    ? new FakeAbuseChecks()
    : await buildRealAbuseChecks(source, limits, findPhashDuplicate)

  const download = makeDownloader(storage)

  const inboundBucket =
    (source.R2_INBOUND_BUCKET ?? "").trim() ||
    ((source.R2_PUBLIC_BASE ?? "").trim().length === 0 ? (source.R2_BUCKET ?? "").trim() : "")
  const usesR2 = localStorageDir.length === 0 && !fakeStorage
  if (usesR2 && inboundBucket.length === 0) {
    console.warn(
      "media-worker: no R2_INBOUND_BUCKET (and R2_PUBLIC_BASE is set), so the inbound-email retention " +
        "lane is DISABLED and archived inbound_emails rows are kept. Set R2_INBOUND_BUCKET to the same " +
        "bucket the API writes inbound mail to.",
    )
  }
  const inboundStorage: Storage | undefined = usesR2
    ? inboundBucket.length === 0
      ? undefined
      : new R2Storage({
          accountId: req(source, "R2_ACCOUNT_ID"),
          accessKeyId: req(source, "R2_ACCESS_KEY_ID"),
          secretAccessKey: req(source, "R2_SECRET_ACCESS_KEY"),
          bucket: inboundBucket,
        })
    : localStorageDir.length > 0
      ? new LocalDiskStorage({
          rootDirectory: localStorageDir,
          namespace: "inbound",
          publicApiUrl: req(source, "PUBLIC_API_URL"),
          signingKey:
            (source.LOCAL_STORAGE_SIGNING_KEY ?? "").trim() || LOCAL_STORAGE_DEV_SIGNING_KEY,
          nodeEnv: source.NODE_ENV ?? "development",
        })
      : storage

  return {
    storage,
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

function req(source: NodeJS.ProcessEnv, key: string): string {
  const v = (source[key] ?? "").trim()
  if (!v) throw new Error(`media-worker: ${key} is required when its real seam is enabled`)
  return v
}

async function buildRealAbuseChecks(
  source: NodeJS.ProcessEnv,
  limits: WorkerLimits,
  findPhashDuplicate: FindPhashDuplicateFn | undefined,
): Promise<AbuseChecks> {
  const { RealAbuseChecks } = await import("@civfix/api/adapters/abuse-checks")
  const { perceptualHash } = await import("./sandbox/phash.js")

  return new RealAbuseChecks({
    ...(source.CF_TURNSTILE_SECRET ? { turnstileSecret: source.CF_TURNSTILE_SECRET } : {}),
    useRealNsfw: parseBool(source.USE_REAL_NSFW, false),
    perceptualHash: (bytes: Uint8Array) => perceptualHash(bytes, limits),
    ...(findPhashDuplicate ? { findPhashDuplicate } : {}),
  })
}

function makePhashDuplicateLookup(dbHandle: DbHandle): FindPhashDuplicateFn {
  return async (
    hash: string,
    opts?: { excludeAssetId?: string; excludeReportId?: string },
  ): Promise<NearDuplicateResult> => {
    const excludeId = opts?.excludeAssetId ?? null
    const excludeReportId = opts?.excludeReportId ?? null
    const rows = await dbHandle.sql<{ report_id: string | null }[]>`
      SELECT report_id
      FROM media_assets
      WHERE phash = ${hash}
        AND report_id IS NOT NULL
        ${excludeId !== null ? dbHandle.sql`AND id <> ${excludeId}` : dbHandle.sql``}
        ${excludeReportId !== null ? dbHandle.sql`AND report_id IS DISTINCT FROM ${excludeReportId}` : dbHandle.sql``}
      ORDER BY created_at ASC
      LIMIT 1
    `
    const ofReportId = rows[0]?.report_id ?? null
    if (ofReportId !== null) return { dup: true, ofReportId }
    return { dup: false }
  }
}
