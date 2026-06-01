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
 */

import type { Storage } from "@civfix/shared/interfaces"

export type DownloadFn = (r2Key: string, maxBytes: number) => Promise<Uint8Array>

/** Error thrown when an object exceeds the byte cap (a safe-rejection trigger upstream). */
export class DownloadTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`download exceeds cap of ${maxBytes} bytes`)
    this.name = "DownloadTooLargeError"
    Object.setPrototypeOf(this, DownloadTooLargeError.prototype)
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

/** Build a DownloadFn over a Storage. */
export function makeDownloader(storage: Storage): DownloadFn {
  return async function download(r2Key: string, maxBytes: number): Promise<Uint8Array> {
    // In-memory fast path (FakeStorage): no network, but still enforce the cap.
    if (isInMemoryReadable(storage)) {
      const bytes = storage.get(r2Key)
      if (bytes === null) {
        throw new Error(`object not found: ${r2Key}`)
      }
      if (bytes.byteLength > maxBytes) {
        throw new DownloadTooLargeError(maxBytes)
      }
      return bytes
    }

    // Real path: presign a GET and stream it with a hard cap.
    const url = await storage.presignGet(r2Key, DOWNLOAD_GET_TTL_SEC)
    const controller = new AbortController()
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) {
      throw new Error(`download failed: HTTP ${res.status} for ${r2Key}`)
    }

    // Reject an over-cap object up front if the server declares its size.
    const declared = Number(res.headers.get("content-length") ?? "")
    if (Number.isFinite(declared) && declared > maxBytes) {
      controller.abort()
      throw new DownloadTooLargeError(maxBytes)
    }

    const body = res.body
    if (!body) {
      // No stream: fall back to arrayBuffer but cap after the fact.
      const buf = new Uint8Array(await res.arrayBuffer())
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
