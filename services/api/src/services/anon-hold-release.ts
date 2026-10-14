import type { AbuseChecks } from "@civfix/shared/interfaces"
import type { LatLng } from "@civfix/shared"
import type { AnonHoldReleaseRepository } from "./anon-hold-release-repository.js"

export interface AnonHoldReleaseDeps {
  repo: AnonHoldReleaseRepository
  abuseChecks: AbuseChecks
  now?: () => Date
  log?: (line: string, extra?: Record<string, unknown>) => void
}

export type ReleaseOutcome =
  | "published"
  | "not_held"
  | "not_anon"
  | "media_pending"
  | "media_blocked"
  | "flagged"
  | "gps_implausible"

export interface ReleaseResult {
  outcome: ReleaseOutcome
  published: boolean
}

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
  if (report.anonSessionId === null) {
    return { outcome: "not_anon", published: false }
  }

  const media = await deps.repo.findMedia(reportId)

  if (media.some((m) => m.status === "rejected" || m.status === "held")) {
    log("anon-hold: media blocked; staying held", { reportId })
    return { outcome: "media_blocked", published: false }
  }
  if (media.some((m) => m.status !== "ready")) {
    return { outcome: "media_pending", published: false }
  }

  const openFlags = await deps.repo.countOpenAbuseFlags(
    reportId,
    media.map((m) => m.id),
  )
  if (openFlags > 0) {
    log("anon-hold: open abuse_flag; staying held", { reportId, openFlags })
    return { outcome: "flagged", published: false }
  }

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

  const flipped = await deps.repo.publishHeldReport(
    reportId,
    now(),
    media.map((m) => m.id),
  )
  if (!flipped) {
    return { outcome: "not_held", published: false }
  }
  log("anon-hold: released held -> published", { reportId })
  return { outcome: "published", published: true }
}
