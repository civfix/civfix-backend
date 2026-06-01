/**
 * Hold-then-publish release for anonymous reports (plan 11.7).
 *
 * An anonymous report is created status "held" and stays HIDDEN (not published+public) until it is
 * proven clean. This module flips a held anon report to "published" once ALL of these hold:
 *   - every attached media asset is status "ready" (none rejected/held, and at least... see note),
 *   - there are NO open abuse_flags for the report (or its media), and
 *   - the report's point is GPS-plausible. The submit-time IP-geo sanity (AbuseChecks.gpsPlausible)
 *     already ran at submit; the per-media EXIF GPS cross-check here is a DOCUMENTED PHASE-1 DEFERRAL
 *     because the worker strips and does NOT persist the original EXIF fix (privacy - see media-checks.ts
 *     and anon-hold-release-repo.drizzle.findMedia). With exifGeo absent the cross-check passes (no signal
 *     cannot contradict the point); the structure below is retained so a future privacy-preserving signal
 *     (a boolean exif_gps_far, never raw coordinates) drops in without reshaping the gate.
 * If any media is rejected/held, or any abuse_flag is open, or the EXIF cross-check (when a signal exists)
 * fails, the report STAYS held - we never publish.
 *
 * MEDIA-LESS REPORTS: an anon report with no media has nothing to validate in the worker, so the "all
 * media ready" condition is vacuously true and (absent flags / GPS issues) it is publishable. The
 * worker only invokes this after a media asset goes ready, so in practice a media-less report is
 * released by a separate path if needed; the function itself treats zero media as "no blocker".
 *
 * IDEMPOTENT + SAFE: releasing an already-published (or non-anon, or deleted) report is a no-op. The
 * flip runs in ONE transaction (set status/published_at + append a "published" timeline row). The
 * worker calls this from the post-success hook of media.checks for the media's report; it never throws
 * in a way that would crash the job (the worker wraps it).
 *
 * All DB access is behind AnonHoldReleaseRepo so the decision + transition are unit-testable with an in-
 * memory impl (no Postgres). The plausibility decision delegates to AbuseChecks.gpsPlausible (the same
 * ~50 km rule as submit), with the EXIF GPS the worker recorded as the second signal.
 */

import type { AbuseChecks } from "@civfix/shared/interfaces"
import type { LatLng } from "@civfix/shared"

/** The held anon report fields the release gate reads. */
export interface HeldReportView {
  id: string
  /** null for an anonymous report (the property we require to treat it as anon-held). */
  reporterUserId: string | null
  anonSessionId: string | null
  status: string
  visibility: string
  lat: number
  lng: number
  deletedAt: Date | null
}

/** A media asset's status as the gate reads it. */
export interface ReleaseMediaView {
  id: string
  status: "validating" | "ready" | "rejected" | "held"
  /** EXIF GPS the worker read from the original bytes, when present (images only). */
  exifGeo?: LatLng | null
}

/**
 * Persistence seam for the release gate. The production impl runs Drizzle/PostGIS; the worker tests use
 * an in-memory impl. Kept narrow: the gate reads the report, its media, and its open-flag count, then
 * (when clean) flips the report in one transaction.
 */
export interface AnonHoldReleaseRepo {
  /** Load the held-report view by id, or null when missing. */
  findReport(reportId: string): Promise<HeldReportView | null>
  /** Media attached to the report (status + any EXIF geo the worker stored). */
  findMedia(reportId: string): Promise<ReleaseMediaView[]>
  /** Count OPEN (resolved_at IS NULL) abuse_flags whose subject is this report OR one of its media. */
  countOpenAbuseFlags(reportId: string, mediaIds: string[]): Promise<number>
  /**
   * Flip the report held -> published in ONE transaction: set status "published", published_at = now,
   * and append a "published" timeline row. Returns true if a row was updated (false when it was no
   * longer held, e.g. a concurrent release won). Idempotent: a no-longer-held report yields false.
   */
  publishHeldReport(reportId: string, publishedAt: Date): Promise<boolean>
}

export interface AnonHoldReleaseDeps {
  repo: AnonHoldReleaseRepo
  abuseChecks: AbuseChecks
  now?: () => Date
  log?: (line: string, extra?: Record<string, unknown>) => void
}

/** Why a release was (not) performed - returned for observability/tests. */
export type ReleaseOutcome =
  | "published"
  | "not_held" // already published / not in a held state / missing / deleted
  | "not_anon" // a signed-in reporter's report (not the anon hold path)
  | "media_pending" // some media not yet ready
  | "media_blocked" // some media rejected/held
  | "flagged" // an open abuse_flag exists
  | "gps_implausible" // the EXIF cross-check failed

export interface ReleaseResult {
  outcome: ReleaseOutcome
  published: boolean
}

/**
 * Evaluate the release gate for `reportId` and publish it when clean. Pure-ish orchestration over the
 * repo + AbuseChecks; returns a structured outcome. Does not throw for the normal "stay held" reasons.
 */
export async function releaseAnonHoldIfReady(
  reportId: string,
  deps: AnonHoldReleaseDeps,
): Promise<ReleaseResult> {
  const now = deps.now ?? (() => new Date())
  const log = deps.log ?? (() => {})

  const report = await deps.repo.findReport(reportId)
  if (!report || report.deletedAt !== null || report.status !== "held") {
    return { outcome: "not_held", published: false }
  }
  // Only the anonymous hold path applies: an anon report has no reporter_user_id. A claimed/owned
  // report is out of scope for this gate.
  if (report.reporterUserId !== null) {
    return { outcome: "not_anon", published: false }
  }

  const media = await deps.repo.findMedia(reportId)

  // Any rejected/held media blocks publication outright.
  if (media.some((m) => m.status === "rejected" || m.status === "held")) {
    log("anon-hold: media blocked; staying held", { reportId })
    return { outcome: "media_blocked", published: false }
  }
  // Any not-yet-ready media means we are not done validating; stay held (a later ready event re-checks).
  if (media.some((m) => m.status !== "ready")) {
    return { outcome: "media_pending", published: false }
  }

  // No open abuse_flags for the report or its media.
  const openFlags = await deps.repo.countOpenAbuseFlags(
    reportId,
    media.map((m) => m.id),
  )
  if (openFlags > 0) {
    log("anon-hold: open abuse_flag; staying held", { reportId, openFlags })
    return { outcome: "flagged", published: false }
  }

  // GPS/EXIF plausibility cross-check. PHASE-1 DEFERRAL: the worker strips EXIF and does not persist the
  // raw GPS (privacy), so m.exifGeo is absent in production and this loop is effectively a no-op; the
  // submit-time IP-geo sanity already covered the point. The loop is kept (and unit-tested with an in-
  // memory exifGeo) so a future privacy-preserving signal activates the gate with no structural change.
  // With no EXIF signal this passes (no signal cannot contradict the point).
  const point: LatLng = { lat: report.lat, lng: report.lng }
  for (const m of media) {
    if (m.exifGeo) {
      const ok = await deps.abuseChecks.gpsPlausible(point, null, m.exifGeo)
      if (!ok) {
        log("anon-hold: EXIF GPS implausible; staying held", { reportId, mediaId: m.id })
        return { outcome: "gps_implausible", published: false }
      }
    }
  }

  // All clear: flip held -> published in one transaction. A false return means a concurrent release
  // already published it, which is fine (still "published" from the caller's perspective).
  const flipped = await deps.repo.publishHeldReport(reportId, now())
  if (!flipped) {
    return { outcome: "not_held", published: false }
  }
  log("anon-hold: released held -> published", { reportId })
  return { outcome: "published", published: true }
}
