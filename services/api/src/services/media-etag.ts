import type { StorageHead } from "@civfix/shared/interfaces"

export interface StorageHeadWithEtag extends StorageHead {
  etag?: string
}

export function normalizeEtag(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null
  const trimmed = raw
    .trim()
    .replace(/^W\//i, "")
    .replace(/^"(.*)"$/s, "$1")
    .trim()
  return trimmed.length > 0 ? trimmed.toLowerCase() : null
}

export function readEtag(head: StorageHead | null | undefined): string | null {
  if (!head) return null
  return normalizeEtag((head as StorageHeadWithEtag).etag)
}
