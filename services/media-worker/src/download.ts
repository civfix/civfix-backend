/**
 * Capped source-byte downloader.
 *
 * The worker must fetch the raw uploaded bytes for an r2_key to process them, but it must NEVER read an
 * unbounded amount (a lying Content-Length or a huge object could exhaust memory). This module builds a
 * DownloadFn that enforces a hard byte cap and aborts early once exceeded.
 *
 * Two backends, chosen by duck-typing the Storage:
 *   - FakeStorage (in tests/offline) exposes a synchronous in-memory `get(key)`; we read straight from
 *     it and still enforce the cap. No network, so the whole pipeline runs offline.
 *   - Real R2Storage: presign a short-lived GET and stream it with fetch, summing chunk sizes and
 *     aborting via AbortController the instant the running total would exceed the cap. We also reject a
 *     declared Content-Length over the cap up front.
 *
 * No vendor SDKs here: the real path uses presignGet (the Storage seam) + global fetch.
 *
 * Failure taxonomy (load-bearing for the orchestrator's reject-vs-retry decision, see media-checks.ts):
 *   - DownloadTooLargeError    -> the object is BAD INPUT (over the byte cap). A legitimate, PERMANENT
 *                                 rejection: the bytes themselves are out of policy, so retrying is futile.
 *   - StorageUnavailableError  -> an INFRA failure to even FETCH the bytes (object-not-found, HTTP 5xx/4xx,
 *                                 presign failure, network/abort). The bytes may be perfectly fine; storage
 *                                 was just unreadable. This must NOT reject the media - the orchestrator
 *                                 re-throws it so pg-boss retries the job once infra recovers.
 */

import type { Storage } from "@civfix/shared/interfaces"

export type DownloadFn = (r2Key: string, maxBytes: number) => Promise<Uint8Array>

/** Error thrown when an object exceeds the byte cap. BAD INPUT -> a safe, PERMANENT rejection upstream. */
export class DownloadTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`download exceeds cap of ${maxBytes} bytes`)
    this.name = "DownloadTooLargeError"
    Object.setPrototypeOf(this, DownloadTooLargeError.prototype)
  }
}

/**
 * Error thrown when the source bytes cannot be FETCHED at all (object-not-found, an HTTP error from the
 * presigned GET, a presign failure, or a network/abort). This is INFRA, not untrusted input: the bytes
 * are not known to be bad, storage was just unreadable. The orchestrator re-throws this (rather than
 * rejecting the media) so the pg-boss job FAILS and RETRIES with backoff, recovering once storage is
 * healthy - so a worker pointed at the wrong storage (e.g. fake-in-prod) never silently destroys media.
 */
export class StorageUnavailableError extends Error {
  constructor(r2Key: string, cause?: unknown) {
    const detail = cause instanceof Error ? cause.message : cause !== undefined ? String(cause) : ""
    super(`storage unavailable for ${r2Key}${detail ? `: ${detail}` : ""}`)
    this.name = "StorageUnavailableError"
    Object.setPrototypeOf(this, StorageUnavailableError.prototype)
  }
}

/** A Storage that also exposes an in-memory getter (FakeStorage). Detected structurally. */
interface InMemoryReadable {
  get(key: string): Uint8Array | null
}

function isInMemoryReadable(s: unknown): s is InMemoryReadable {
  return typeof (s as { get?: unknown }).get === "function"
}

/** TTL for the presigned GET the downloader mints (short: it is used immediately). */
const DOWNLOAD_GET_TTL_SEC = 120

/**
 * Worker-internal r2 keys are content-addressed (`uploads/yyyy/mm/<sha256>`); the worker also reads its
 * own derived `thumbs/`/`processed/` objects. presignGet is the only guard before a server-side fetch of
 * the key, so reject a poisoned-DB-row key that escapes the prefix or contains path traversal before
 * presigning. (Not request-SSRF — the key never comes from the client — but a cheap defensive backstop.)
 */
function isSafeR2Key(key: string): boolean {
  if (key.length === 0 || key.length > 512) return false
  if (key.startsWith("/") || key.includes("..") || key.includes("\\")) return false
  return /^[A-Za-z0-9._\-/]+$/.test(key)
}

/** Build a DownloadFn over a Storage. */
export function makeDownloader(storage: Storage): DownloadFn {
  return async function download(r2Key: string, maxBytes: number): Promise<Uint8Array> {
    // In-memory fast path (FakeStorage): no network, but still enforce the cap.
    if (isInMemoryReadable(storage)) {
      const bytes = storage.get(r2Key)
      if (bytes === null) {
        // Object missing from the store. INFRA, not bad input (e.g. a fake store standing in for real
        // R2): retryable, never a permanent reject. (Also what a wrong-storage worker hits in prod.)
        throw new StorageUnavailableError(r2Key)
      }
      if (bytes.byteLength > maxBytes) {
        throw new DownloadTooLargeError(maxBytes)
      }
      return bytes
    }

    // Real path: presign a GET and stream it with a hard cap. presign + fetch failures are INFRA
    // (storage unreadable), so they surface as StorageUnavailableError -> the job retries, never rejects.
    if (!isSafeR2Key(r2Key)) {
      // A malformed key (a poisoned DB row) is unfetchable; surface it as infra so the job is isolated
      // (never crashes the worker) and the orphan sweep eventually reaps the bad row.
      throw new StorageUnavailableError(r2Key, "unsafe r2 key")
    }
    let url: string
    try {
      url = await storage.presignGet(r2Key, DOWNLOAD_GET_TTL_SEC)
    } catch (err) {
      throw new StorageUnavailableError(r2Key, err)
    }
    const controller = new AbortController()
    let res: Response
    try {
      res = await fetch(url, { signal: controller.signal })
    } catch (err) {
      // Network failure / abort / DNS, etc. The bytes are not known-bad; storage was just unreachable.
      throw new StorageUnavailableError(r2Key, err)
    }
    if (!res.ok) {
      // Any non-2xx from the presigned GET (404 object-not-found, 5xx, expired presign, ...) is INFRA.
      throw new StorageUnavailableError(r2Key, `HTTP ${res.status}`)
    }

    // Reject an over-cap object up front if the server declares its size.
    const declared = Number(res.headers.get("content-length") ?? "")
    if (Number.isFinite(declared) && declared > maxBytes) {
      controller.abort()
      throw new DownloadTooLargeError(maxBytes)
    }

    const body = res.body
    if (!body) {
      // No stream: fall back to arrayBuffer but cap after the fact. A read failure here is INFRA.
      let buf: Uint8Array
      try {
        buf = new Uint8Array(await res.arrayBuffer())
      } catch (err) {
        throw new StorageUnavailableError(r2Key, err)
      }
      if (buf.byteLength > maxBytes) throw new DownloadTooLargeError(maxBytes)
      return buf
    }

    const reader = body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) {
          total += value.byteLength
          if (total > maxBytes) {
            controller.abort()
            throw new DownloadTooLargeError(maxBytes)
          }
          chunks.push(value)
        }
      }
    } catch (err) {
      // The over-cap abort above is BAD INPUT; let it through unchanged. Any other mid-stream read
      // failure (a network drop) is INFRA -> retryable.
      if (err instanceof DownloadTooLargeError) throw err
      throw new StorageUnavailableError(r2Key, err)
    } finally {
      reader.releaseLock()
    }

    const out = new Uint8Array(total)
    let offset = 0
    for (const c of chunks) {
      out.set(c, offset)
      offset += c.byteLength
    }
    return out
  }
}
