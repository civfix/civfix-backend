
import type { Storage } from "@civfix/shared/interfaces"
import { normalizeEtag, readEtag } from "@civfix/api/media-repo"

/**
 * The bytes plus the object VERSION they came from (C1). `etag` is null when the storage seam reports
 * none (offline fakes); the media.checks job compares it against the finalize-time ETag and re-checks it
 * immediately before publishing, so bytes swapped mid-flight are rejected instead of published.
 */
export interface DownloadedObject {
  bytes: Uint8Array
  etag: string | null
}

export type DownloadFn = (
  r2Key: string,
  maxBytes: number,
  signal?: AbortSignal,
) => Promise<DownloadedObject>

export class DownloadTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`download exceeds cap of ${maxBytes} bytes`)
    this.name = "DownloadTooLargeError"
    Object.setPrototypeOf(this, DownloadTooLargeError.prototype)
  }
}

export class StorageUnavailableError extends Error {
  constructor(r2Key: string, cause?: unknown) {
    const detail = cause instanceof Error ? cause.message : cause !== undefined ? String(cause) : ""
    super(`storage unavailable for ${r2Key}${detail ? `: ${detail}` : ""}`)
    this.name = "StorageUnavailableError"
    Object.setPrototypeOf(this, StorageUnavailableError.prototype)
  }
}

interface InMemoryReadable {
  get(key: string): Uint8Array | null
}

function isInMemoryReadable(s: unknown): s is InMemoryReadable {
  return typeof (s as { get?: unknown }).get === "function"
}

const DOWNLOAD_GET_TTL_SEC = 120

function isSafeR2Key(key: string): boolean {
  if (key.length === 0 || key.length > 512) return false
  if (key.startsWith("/") || key.includes("..") || key.includes("\\")) return false
  return /^[A-Za-z0-9._\-/]+$/.test(key)
}

export function makeDownloader(storage: Storage): DownloadFn {
  return async function download(
    r2Key: string,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<DownloadedObject> {
    if (isInMemoryReadable(storage)) {
      const bytes = storage.get(r2Key)
      if (bytes === null) {
        throw new StorageUnavailableError(r2Key)
      }
      if (bytes.byteLength > maxBytes) {
        throw new DownloadTooLargeError(maxBytes)
      }
      return { bytes, etag: await headEtag(storage, r2Key) }
    }

    if (!isSafeR2Key(r2Key)) {
      throw new StorageUnavailableError(r2Key, "unsafe r2 key")
    }
    let url: string
    try {
      // MUST resolve to a signed, direct-to-bucket GET. The shared Storage interface has no forceSigned
      // option, so that is guaranteed upstream instead: seams.ts constructs the worker's R2Storage WITHOUT
      // publicBase, because fetching the unprocessed original through a public CDN URL would cache the
      // pre-strip bytes at the key clients read the stripped object from.
      url = await storage.presignGet(r2Key, DOWNLOAD_GET_TTL_SEC)
    } catch (err) {
      throw new StorageUnavailableError(r2Key, err)
    }
    const controller = new AbortController()
    if (signal) {
      if (signal.aborted) controller.abort()
      else signal.addEventListener("abort", () => controller.abort(), { once: true })
    }
    let res: Response
    try {
      res = await fetch(url, { signal: controller.signal })
    } catch (err) {
      throw new StorageUnavailableError(r2Key, err)
    }
    if (!res.ok) {
      // Drain the error body so undici releases the socket now instead of at GC.
      await res.body?.cancel().catch(() => {})
      throw new StorageUnavailableError(r2Key, `HTTP ${res.status}`)
    }

    const declared = Number(res.headers.get("content-length") ?? "")
    if (Number.isFinite(declared) && declared > maxBytes) {
      controller.abort()
      throw new DownloadTooLargeError(maxBytes)
    }

    const etag = normalizeEtag(res.headers.get("etag"))

    const body = res.body
    if (!body) {
      let buf: Uint8Array
      try {
        buf = new Uint8Array(await res.arrayBuffer())
      } catch (err) {
        throw new StorageUnavailableError(r2Key, err)
      }
      if (buf.byteLength > maxBytes) throw new DownloadTooLargeError(maxBytes)
      return { bytes: buf, etag }
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
    return { bytes: out, etag }
  }
}

async function headEtag(storage: Storage, r2Key: string): Promise<string | null> {
  return readEtag(await storage.head(r2Key))
}
