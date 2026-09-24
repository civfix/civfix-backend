import type { Storage } from "@civfix/shared/interfaces"
import { normalizeEtag, readEtag } from "@civfix/api/media-repo"
import { loadHttpsProxy } from "./config.js"

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
const MAX_R2_KEY_LENGTH = 512
const SAFE_R2_KEY_PATTERN = /^[A-Za-z0-9._\-/]+$/

function isSafeR2Key(key: string): boolean {
  if (key.length === 0 || key.length > MAX_R2_KEY_LENGTH) return false
  if (key.startsWith("/") || key.includes("..") || key.includes("\\")) return false
  return SAFE_R2_KEY_PATTERN.test(key)
}

export function makeDownloader(storage: Storage): DownloadFn {
  return async function download(
    r2Key: string,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<DownloadedObject> {
    if (isInMemoryReadable(storage)) {
      return downloadInMemory(storage, r2Key, maxBytes)
    }

    if (!isSafeR2Key(r2Key)) {
      throw new StorageUnavailableError(r2Key, "unsafe r2 key")
    }
    let url: string
    try {
      url = await storage.presignGet(r2Key, DOWNLOAD_GET_TTL_SEC)
    } catch (err) {
      throw new StorageUnavailableError(r2Key, err)
    }
    const controller = linkedAbortController(signal)
    let res: Response
    try {
      res = await proxyAwareFetch(url, controller.signal)
    } catch (err) {
      throw new StorageUnavailableError(r2Key, err)
    }
    if (!res.ok) {
      // Only frees the socket; the status error below is what the caller acts on.
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
      return { bytes: await readWholeBody(res, r2Key, maxBytes), etag }
    }
    return { bytes: await readCappedStream(body, r2Key, maxBytes, controller), etag }
  }
}

async function downloadInMemory(
  storage: Storage & InMemoryReadable,
  r2Key: string,
  maxBytes: number,
): Promise<DownloadedObject> {
  const bytes = storage.get(r2Key)
  if (bytes === null) {
    throw new StorageUnavailableError(r2Key)
  }
  if (bytes.byteLength > maxBytes) {
    throw new DownloadTooLargeError(maxBytes)
  }
  return { bytes, etag: await headEtag(storage, r2Key) }
}

function linkedAbortController(signal: AbortSignal | undefined): AbortController {
  const controller = new AbortController()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener("abort", () => controller.abort(), { once: true })
  }
  return controller
}

async function readWholeBody(res: Response, r2Key: string, maxBytes: number): Promise<Uint8Array> {
  let buf: Uint8Array
  try {
    buf = new Uint8Array(await res.arrayBuffer())
  } catch (err) {
    throw new StorageUnavailableError(r2Key, err)
  }
  if (buf.byteLength > maxBytes) throw new DownloadTooLargeError(maxBytes)
  return buf
}

// The cap is enforced while streaming, so a body that lies about (or omits) its content-length is cut
// off at maxBytes instead of being buffered whole.
async function readCappedStream(
  body: ReadableStream<Uint8Array>,
  r2Key: string,
  maxBytes: number,
  controller: AbortController,
): Promise<Uint8Array> {
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
  return concatChunks(chunks, total)
}

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}

async function headEtag(storage: Storage, r2Key: string): Promise<string | null> {
  return readEtag(await storage.head(r2Key))
}

let proxyDispatcher: import("undici").EnvHttpProxyAgent | undefined

async function proxyAwareFetch(url: string, signal: AbortSignal): Promise<Response> {
  if (loadHttpsProxy() === null) return fetch(url, { signal })
  const { fetch: undiciFetch, EnvHttpProxyAgent } = await import("undici")
  proxyDispatcher ??= new EnvHttpProxyAgent()
  return (await undiciFetch(url, { signal, dispatcher: proxyDispatcher })) as unknown as Response
}
