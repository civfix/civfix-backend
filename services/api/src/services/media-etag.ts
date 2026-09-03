/**
 * Object-version identity for the media pipeline (C1).
 *
 * The @civfix/shared `Storage` seam does not carry an ETag on `StorageHead`, so the adapters that HAVE
 * one (R2, and the local-disk driver, which derives a content hash) return it as an EXTRA field on the
 * head result and consumers read it through `readEtag`. A seam that reports no ETag simply yields null
 * and the caller skips the comparison — never a silent pass on a MISMATCH, only on "no version data at
 * all" (FakeStorage in offline harnesses).
 *
 * Proposed contract follow-up: `StorageHead.etag?: string` in @civfix/shared/interfaces, at which point
 * `readEtag` becomes a plain property read.
 */

import type { StorageHead } from "@civfix/shared/interfaces"

export interface StorageHeadWithEtag extends StorageHead {
  etag?: string
}

/**
 * Canonical form for comparing two ETags: S3/R2 quote them, may prefix a weak marker, and vary the case
 * of the hex digest. A blank value is "no version data".
 */
export function normalizeEtag(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null
  const trimmed = raw.trim().replace(/^W\//i, "").replace(/^"(.*)"$/s, "$1").trim()
  return trimmed.length > 0 ? trimmed.toLowerCase() : null
}

/** Read the ETag off a head result that may or may not carry one. */
export function readEtag(head: StorageHead | null | undefined): string | null {
  if (!head) return null
  return normalizeEtag((head as StorageHeadWithEtag).etag)
}
