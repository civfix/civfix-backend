/**
 * Worker seam selection (the worker's own tiny DI).
 *
 * The worker is a separate process from the API and must boot OFFLINE with the same USE_FAKE_* flags.
 * It does NOT import the API's Fastify DI container (that would drag in every HTTP adapter); it wires
 * only what the media pipeline needs: Storage, AbuseChecks, a DB handle + the media-worker repo, a
 * capped byte downloader, and an error reporter. Real-vs-fake mirrors the API's rules:
 *
 *   storage      REAL R2Storage        unless USE_FAKE_STORAGE      -> FakeStorage
 *   abuseChecks  REAL RealAbuseChecks   unless USE_FAKE_ABUSE_NSFW   -> FakeAbuseChecks
 *   db / repo    created only when NOT all-fake (a real DB is required to persist results)
 *
 * The Drizzle schema, the postgres-js client, the worker repo, the R2 adapter, and the GlitchTip
 * reporter are all imported from @civfix/api so there is a SINGLE source of truth (no duplication).
 *
 * Seam rule: the only vendor pieces here are the R2 adapter + Sentry reporter, both imported from the
 * API's adapter/error files (where the SDKs are confined); sharp/ffmpeg live in sandbox/.
 */

import { FakeStorage, FakeAbuseChecks } from "@civfix/shared/fakes"
import type { AbuseChecks, Storage } from "@civfix/shared/interfaces"
import { makeDb, type DbHandle } from "@civfix/api/db"
import { makeDrizzleMediaWorkerRepo, type MediaWorkerRepo } from "@civfix/api/media-repo"
import { makeDrizzleAnonHoldReleaseRepo } from "@civfix/api/anon-hold-repo"
import type { AnonHoldReleaseRepo } from "@civfix/api/anon-hold-release"
import { R2Storage } from "@civfix/api/adapters/storage"
import { captureError, initErrorReporting, flushErrorReporting } from "@civfix/api/errors"
import { loadLimits, parseBool, type WorkerLimits } from "./config.js"
import { makeDownloader, type DownloadFn } from "./download.js"

export interface WorkerSeams {
  storage: Storage
  abuseChecks: AbuseChecks
  limits: WorkerLimits
  download: DownloadFn
  /** DB handle (undefined in all-fake mode where no DB is configured). */
  dbHandle: DbHandle | undefined
  /** Worker media repo (undefined in all-fake mode). */
  repo: MediaWorkerRepo | undefined
  /** Anon hold-release gate repo (undefined in all-fake mode; needs a real DB). */
  anonHoldRepo: AnonHoldReleaseRepo | undefined
  /** Report an error to GlitchTip (no-op when no DSN). */
  report: (err: unknown, context?: Record<string, unknown>) => void
  /** Tear down created resources (DB pool, flush telemetry). */
  close(): Promise<void>
}

/** Decide a USE_FAKE_* flag with the API's rule: default ON outside production. */
function useFake(source: NodeJS.ProcessEnv, key: string): boolean {
  const isProd = source.NODE_ENV === "production"
  return parseBool(source[key], !isProd)
}

/**
 * Build the worker seams from env. Initializes GlitchTip (no-op without a DSN). When a real DB is
 * required (results must be persisted) but DATABASE_URL is missing, throws so misconfiguration is loud;
 * in all-fake/offline mode it skips the DB entirely.
 */
export async function buildSeams(source: NodeJS.ProcessEnv = process.env): Promise<WorkerSeams> {
  const limits = loadLimits(source)

  const fakeStorage = useFake(source, "USE_FAKE_STORAGE")
  const fakeAbuse = useFake(source, "USE_FAKE_ABUSE_NSFW")

  // Error reporting (shared GlitchTip helper). Safe no-op when GLITCHTIP_DSN is unset.
  await initErrorReporting({
    ...(source.GLITCHTIP_DSN ? { dsn: source.GLITCHTIP_DSN } : {}),
    environment: source.NODE_ENV ?? "development",
    release: "media-worker@0.0.0",
  })

  // ----- storage -----
  const storage: Storage = fakeStorage
    ? new FakeStorage()
    : new R2Storage({
        accountId: req(source, "R2_ACCOUNT_ID"),
        accessKeyId: req(source, "R2_ACCESS_KEY_ID"),
        secretAccessKey: req(source, "R2_SECRET_ACCESS_KEY"),
        bucket: req(source, "R2_BUCKET"),
        ...(source.R2_PUBLIC_BASE ? { publicBase: source.R2_PUBLIC_BASE } : {}),
      })

  // ----- abuse checks (NSFW behind the seam) -----
  const abuseChecks: AbuseChecks = fakeAbuse
    ? new FakeAbuseChecks()
    : // RealAbuseChecks lives in the API adapter; the worker only needs nsfwScore/isNearDuplicate here.
      // It is constructed lazily by the API DI in the API process; for the worker we import the class.
      await buildRealAbuseChecks(source)

  // ----- db + repo (only when results must be persisted to a real DB) -----
  let dbHandle: DbHandle | undefined
  let repo: MediaWorkerRepo | undefined
  let anonHoldRepo: AnonHoldReleaseRepo | undefined
  const databaseUrl = (source.DATABASE_URL ?? "").trim()
  if (databaseUrl) {
    dbHandle = makeDb(databaseUrl)
    repo = makeDrizzleMediaWorkerRepo(dbHandle.db)
    anonHoldRepo = makeDrizzleAnonHoldReleaseRepo(dbHandle.sql)
  } else if (source.NODE_ENV === "production") {
    throw new Error("media-worker: DATABASE_URL is required in production to persist media results")
  }

  const download = makeDownloader(storage)

  return {
    storage,
    abuseChecks,
    limits,
    download,
    dbHandle,
    repo,
    anonHoldRepo,
    report: captureError,
    async close(): Promise<void> {
      if (dbHandle) await dbHandle.close()
      await flushErrorReporting()
    },
  }
}

/** Read a required env var, throwing a clear error when missing (only reached when a real seam needs it). */
function req(source: NodeJS.ProcessEnv, key: string): string {
  const v = (source[key] ?? "").trim()
  if (!v) throw new Error(`media-worker: ${key} is required when its real seam is enabled`)
  return v
}

/**
 * Construct the REAL AbuseChecks. Imported lazily so the @sentry/onnx/turnstile machinery referenced by
 * the adapter is never loaded in all-fake mode. The adapter is the API's RealAbuseChecks (the seam SDK
 * stays confined there); a real NSFW model is a flag-gated follow-up that swaps this body only.
 */
async function buildRealAbuseChecks(source: NodeJS.ProcessEnv): Promise<AbuseChecks> {
  const { RealAbuseChecks } = await import("@civfix/api/adapters/abuse-checks")
  return new RealAbuseChecks(
    source.CF_TURNSTILE_SECRET ? { turnstileSecret: source.CF_TURNSTILE_SECRET } : {},
  )
}
