/**
 * Served-versions policy — the operational, backend-owned half of API versioning.
 *
 * The shared contract (`@civfix/shared/client`) owns the version→path *mapping* (which version each
 * endpoint is declared under, and how `versionedPath` turns that into a wire path). This module owns
 * the orthogonal *operational* question: of the versions the contract knows about, which does THIS
 * deployment actually serve right now, and what is each one's lifecycle state (current / deprecated /
 * sunset)?
 *
 * THIS IS THE SINGLE PLACE to flip a version's lifecycle. To deprecate `v1` (announce a sunset while
 * still serving it), set its entry to `{ status: "deprecated", sunset: "<ISO date>" }`; to stop
 * serving it entirely, set `{ status: "sunset" }` and drop it from `SERVED_VERSIONS` (or raise
 * `MIN_SUPPORTED_VERSION`). The version-gate plugin reads only this module, so no other code changes.
 *
 * Today only `v1` exists and it is `current`, so the gate's only active behavior is rejecting unknown
 * `/vN` segments — which is the desired immediate hardening.
 */

import type { ApiVersion } from "@civfix/shared/client"

/** Lifecycle state of a served API version. */
export type VersionLifecycle = "current" | "deprecated" | "sunset"

/** Per-version lifecycle descriptor. `sunset` (ISO-8601 date) is only meaningful for "deprecated". */
export interface VersionStatus {
  readonly status: VersionLifecycle
  /** ISO-8601 date a deprecated version stops being served. Surfaced in the `Sunset` response header. */
  readonly sunset?: string
}

/**
 * Versions this deployment serves, newest-supported first. A `/vN` segment not in this set is rejected
 * by the gate (400 UNSUPPORTED_API_VERSION) unless it is a known-but-sunset version (410, see below).
 */
export const SERVED_VERSIONS: readonly ApiVersion[] = ["v1"] as const

/**
 * Oldest version still accepted. A syntactically valid `/vN` whose N is below this floor is rejected as
 * unsupported (400) even if the segment is otherwise well-formed. Raise this to retire old majors.
 */
export const MIN_SUPPORTED_VERSION: ApiVersion = "v1"

/**
 * Lifecycle map keyed by every `ApiVersion` the contract defines. `Record<ApiVersion, ...>` makes this
 * exhaustive by construction: adding a new `ApiVersion` to the shared union forces a compile error here
 * until its lifecycle is declared, so a new version can never be silently un-policied.
 */
export const VERSION_STATUS: Record<ApiVersion, VersionStatus> = {
  v1: { status: "current" },
} as const

/** Numeric major extracted from a `vN` segment, or `null` if the segment is not of that shape. */
function majorOf(seg: string): number | null {
  const match = /^v(\d+)$/.exec(seg)
  if (!match) return null
  return Number.parseInt(match[1]!, 10)
}

/** True iff `seg` matches the `/^v\d+$/` shape of an API-version path segment (e.g. "v1", "v2"). */
export function isVersionSegment(seg: string): boolean {
  return majorOf(seg) !== null
}

/** True iff `seg` is a version this deployment currently serves (current OR deprecated, not sunset). */
export function isServedVersion(seg: string): boolean {
  return SERVED_VERSIONS.includes(seg as ApiVersion)
}

/**
 * Lifecycle status for a version segment, or `null` if the contract does not define it at all (an
 * unknown `vN`). A known-but-sunset version returns `{ status: "sunset" }` so the gate can answer 410
 * rather than 400.
 */
export function versionStatus(seg: string): VersionStatus | null {
  if (!isVersionSegment(seg)) return null
  return VERSION_STATUS[seg as ApiVersion] ?? null
}

/**
 * True iff `seg` is a well-formed `vN` whose major is below `MIN_SUPPORTED_VERSION` — i.e. a version we
 * have retired below the floor. Such a segment is "unsupported" (400) regardless of its presence in the
 * lifecycle map.
 */
export function isBelowMinSupported(seg: string): boolean {
  const major = majorOf(seg)
  if (major === null) return false
  const min = majorOf(MIN_SUPPORTED_VERSION)
  if (min === null) return false
  return major < min
}
