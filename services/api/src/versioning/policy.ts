/**
 * The contract owns which version each endpoint is declared under; this module owns which versions THIS
 * deployment serves and each one's lifecycle. It is the single place to flip a lifecycle: deprecate with
 * `{ status: "deprecated", sunset: "<ISO date>" }`; retire with `{ status: "sunset" }` plus dropping it from
 * `SERVED_VERSIONS` (or raising `MIN_SUPPORTED_VERSION`). The version gate reads only this module.
 */

import type { ApiVersion } from "@civfix/shared/client"

export type VersionLifecycle = "current" | "deprecated" | "sunset"

export interface VersionStatus {
  readonly status: VersionLifecycle
  /** ISO-8601 date, only meaningful for "deprecated"; surfaced in the `Sunset` response header. */
  readonly sunset?: string
}

export const SERVED_VERSIONS: readonly ApiVersion[] = ["v1"] as const

export const MIN_SUPPORTED_VERSION: ApiVersion = "v1"

/** `Record<ApiVersion, ...>` forces a compile error here when the contract gains a version with no policy. */
export const VERSION_STATUS: Record<ApiVersion, VersionStatus> = {
  v1: { status: "current" },
} as const

const VERSION_SEGMENT_RE = /^v\d+$/

function majorOf(seg: string): number | null {
  const match = /^v(\d+)$/.exec(seg)
  if (!match) return null
  return Number.parseInt(match[1]!, 10)
}

export function isVersionSegment(seg: string): boolean {
  return VERSION_SEGMENT_RE.test(seg)
}

export function isServedVersion(seg: string): boolean {
  return SERVED_VERSIONS.includes(seg as ApiVersion)
}

/** A known-but-sunset version returns its entry so the gate can answer 410 rather than 400. */
export function versionStatus(seg: string): VersionStatus | null {
  if (!isVersionSegment(seg)) return null
  return VERSION_STATUS[seg as ApiVersion] ?? null
}

export function isBelowMinSupported(seg: string): boolean {
  const major = majorOf(seg)
  if (major === null) return false
  const min = majorOf(MIN_SUPPORTED_VERSION)
  if (min === null) return false
  return major < min
}

/** Fails boot on an inconsistent policy instead of surfacing it as confusing 4xxs in prod. */
export function validateVersionPolicy(): void {
  const problems: string[] = []
  for (const v of [MIN_SUPPORTED_VERSION, ...SERVED_VERSIONS]) {
    const status = VERSION_STATUS[v]
    if (!status) problems.push(`${v}: no VERSION_STATUS entry`)
    else if (status.status === "sunset") problems.push(`${v}: served/min but marked sunset`)
  }
  if (problems.length > 0) {
    throw new Error(`API version policy is inconsistent: ${problems.join("; ")}`)
  }
}
