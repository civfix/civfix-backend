/**
 * Worker seam selection (the worker's own tiny DI).
 *
 * The worker is a separate process from the API and must boot OFFLINE with the same USE_FAKE_* flags.
 * It does NOT import the API's Fastify DI container (that would drag in every HTTP adapter); it wires
 * only what the media pipeline needs: Storage, AbuseChecks, a DB handle + the media-worker repo, a
 * capped byte downloader, and an error reporter. Real-vs-fake mirrors the API's rules:
 *
 *   storage      REAL R2Storage        unless USE_FAKE_STORAGE      -> FakeStorage
 *                REQUIRED-REAL IN PRODUCTION: the worker reads the API's uploaded bytes from storage, so
 *                a fake in-memory store in prod is ALWAYS empty -> every download misses -> media is lost.
 *                buildSeams() throws on USE_FAKE_STORAGE in production (mirrors the API's required-creds
 *                boot enforcement). USE_FAKE_ABUSE_NSFW stays togglable (intentional pre-launch state).
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
import type { AbuseChecks, NearDuplicateResult, Storage } from "@civfix/shared/interfaces"
import type { FindPhashDuplicateFn } from "@civfix/api/adapters/abuse-checks"
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
  /**
   * Self-aware near-duplicate lookup over media_assets.phash (undefined in all-fake mode where no DB is
   * configured). The media.checks job calls this directly with the processing asset's id as
   * excludeAssetId so a re-delivered job never flags an asset as a duplicate of itself (P0-2). When
   * undefined, the pipeline falls back to AbuseChecks.isNearDuplicate (the FakeAbuseChecks dedupe memory
   * in offline mode), which has no persisted self-row to collide with.
   */
  findPhashDuplicate: FindPhashDuplicateFn | undefined
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

  // PRODUCTION GUARD (mirrors the API's required-creds boot enforcement, and the DATABASE_URL throw
  // below): the worker fetches the API's real uploaded bytes from storage. A fake in-memory store in
  // production is ALWAYS empty, so every download misses -> the pipeline would treat real media as an
  // infra failure and the upload could be lost. Fail boot LOUDLY rather than silently mis-process. Note:
  // USE_FAKE_ABUSE_NSFW is deliberately NOT guarded - running the NSFW seam fake pre-launch is intended.
  if (source.NODE_ENV === "production" && fakeStorage) {
    throw new Error(
      "media-worker: USE_FAKE_STORAGE must be 0 in production - the worker reads the API's uploaded " +
        "bytes from R2; a fake in-memory store is empty in prod and would lose media. Provide the R2 " +
        "credentials (R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET).",
    )
  }

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

  // ----- db + repo (only when results must be persisted to a real DB) -----
  // Built BEFORE abuse checks so the near-duplicate lookup can query media_assets phash via the sql tag.
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

  // The self-aware near-duplicate lookup (media_assets.phash query with AND id <> selfId, P0-2). Built
  // once when a DB is configured; the media.checks job passes the processing asset's id so a re-delivered
  // job never matches the asset against its own row. Also handed to RealAbuseChecks below so the adapter's
  // isNearDuplicate stays functional for any caller that does not thread a self id.
  const findPhashDuplicate: FindPhashDuplicateFn | undefined = dbHandle
    ? makePhashDuplicateLookup(dbHandle)
    : undefined

  // ----- abuse checks (NSFW + perceptual hash + near-dup behind the seam) -----
  // RealAbuseChecks lives in the API adapter (Turnstile SDK is confined there). The worker injects the
  // REAL perceptual hasher (sharp-based dHash from sandbox/phash.ts, kept out of the adapter per the
  // seam rule) and a media_assets-backed near-duplicate lookup. NSFW stays benign-by-default unless
  // USE_REAL_NSFW + a model is wired (no model vendored yet, so it logs once and scores benign).
  const abuseChecks: AbuseChecks = fakeAbuse
    ? new FakeAbuseChecks()
    : await buildRealAbuseChecks(source, limits, findPhashDuplicate)

  const download = makeDownloader(storage)

  return {
    storage,
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

/** Read a required env var, throwing a clear error when missing (only reached when a real seam needs it). */
function req(source: NodeJS.ProcessEnv, key: string): string {
  const v = (source[key] ?? "").trim()
  if (!v) throw new Error(`media-worker: ${key} is required when its real seam is enabled`)
  return v
}

/**
 * Construct the REAL AbuseChecks for the worker. The adapter (API's RealAbuseChecks) keeps the Turnstile
 * SDK confined; the worker injects the pieces that must NOT live in the adapter:
 *   - perceptualHash: the sharp-based dHash from sandbox/phash.ts (sharp stays in sandbox/ per the seam
 *     rule), so pHash returns a REAL perceptual signature rather than the adapter's byte-hash fallback.
 *   - findPhashDuplicate: an exact-match media_assets phash lookup (Phase 1: exact match is enough),
 *     wired only when a DB is configured; otherwise the adapter's benign { dup: false } default applies.
 *   - useRealNsfw: the USE_REAL_NSFW flag (default false). No NSFW model is vendored yet, so even when
 *     true the adapter logs once and scores benign (never throws) - a flag-gated follow-up.
 * Imported lazily so the adapter's vendor machinery is never loaded in all-fake mode.
 */
async function buildRealAbuseChecks(
  source: NodeJS.ProcessEnv,
  limits: WorkerLimits,
  findPhashDuplicate: FindPhashDuplicateFn | undefined,
): Promise<AbuseChecks> {
  const { RealAbuseChecks } = await import("@civfix/api/adapters/abuse-checks")
  // The real perceptual hasher lives in the sandbox (sharp). Bind it to the worker limits.
  const { perceptualHash } = await import("./sandbox/phash.js")

  return new RealAbuseChecks({
    ...(source.CF_TURNSTILE_SECRET ? { turnstileSecret: source.CF_TURNSTILE_SECRET } : {}),
    useRealNsfw: parseBool(source.USE_REAL_NSFW, false),
    perceptualHash: (bytes: Uint8Array) => perceptualHash(bytes, limits),
    ...(findPhashDuplicate ? { findPhashDuplicate } : {}),
  })
}

/**
 * Build an exact-match near-duplicate lookup over media_assets.phash. Returns { dup: true, ofReportId }
 * when ANOTHER asset already carries the same phash and is attached to a report; otherwise { dup: false }.
 * Exact match is sufficient for Phase 1 (the phash column is indexed); a future phase can widen this to
 * a bounded Hamming distance. The query is read-only and fail-safe at the call site (the media pipeline
 * treats a dedupe error as "not a duplicate").
 *
 * NON-BLOCKING CONSUMER (issue #43): the pipeline (applyAbuseSeams) now treats a near-duplicate as a
 * NON-blocking signal - it is detected/logged but the asset is NOT held and no phash_dup flag is raised
 * (auto-holding silently hid legitimate report media and broke the gallery). This lookup is unchanged
 * and still reports `{ dup: true, ofReportId }`; the two exclusions below keep that REPORTED signal
 * accurate (no self/sibling false positive) even though it no longer drives a hold.
 *
 * SELF-EXCLUSION (P0-2): the asset being processed already has its OWN row (with a report_id set at
 * report-create) and, after its first run, its OWN persisted phash. A re-delivered/double-enqueued
 * media.checks job recomputes the identical phash; without excluding the current asset the lookup would
 * match the asset's own row and report it a near-duplicate of itself - a bogus self-match signal (and,
 * back when a dup held the asset, a clean upload flipped to held forever). `excludeAssetId` (threaded
 * from the processing asset's id) adds `AND id <> $selfId` so the asset can never be its own duplicate;
 * a genuinely different asset sharing the phash still matches.
 *
 * CROSS-REPORT SCOPING (issue #43): a single report can carry MULTIPLE photos. Without scoping, two
 * SIBLING photos of the same report that happen to share a phash would each be reported as a duplicate
 * of the other. `excludeReportId` (threaded from the processing asset's own report_id) adds
 * `AND report_id IS DISTINCT FROM $excludeReportId` so a sibling in the SAME report is never reported as
 * a duplicate; a genuine CROSS-report duplicate still matches (and is now allowed through by the
 * non-blocking consumer above). When `excludeReportId` is omitted (e.g. an unattached upload with a null
 * report_id) the predicate is skipped and behavior is unchanged.
 */
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
