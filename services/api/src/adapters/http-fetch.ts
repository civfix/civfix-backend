export type FetchJsonResult<T> =
  | { ok: true; status: number; json: T }
  | { ok: false; kind: "http"; status: number }
  | { ok: false; kind: "transport"; error: unknown }
  | { ok: false; kind: "body"; status: number; error: unknown }

export const DEFAULT_MAX_JSON_BYTES = 1024 * 1024

export class JsonBodyTooLargeError extends Error {
  constructor(public readonly maxBytes: number) {
    super(`response body exceeds ${maxBytes} bytes`)
    this.name = "JsonBodyTooLargeError"
  }
}

export interface FetchJsonOptions {
  timeoutMs: number
  fetchImpl?: typeof fetch
  maxBytes?: number
  init?: Omit<RequestInit, "signal">
}

export async function fetchJsonWithTimeout<T>(
  url: string,
  opts: FetchJsonOptions,
): Promise<FetchJsonResult<T>> {
  const doFetch = opts.fetchImpl ?? globalThis.fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs)
  try {
    let res: Response
    try {
      res = await doFetch(url, {
        redirect: "error",
        ...opts.init,
        signal: controller.signal,
      })
    } catch (error) {
      return { ok: false, kind: "transport", error }
    }
    const status = typeof res.status === "number" ? res.status : 0
    if (!res.ok) {
      await res.body?.cancel().catch(() => {})
      return { ok: false, kind: "http", status }
    }
    const maxBytes = opts.maxBytes ?? DEFAULT_MAX_JSON_BYTES
    const declared =
      typeof res.headers?.get === "function"
        ? Number(res.headers.get("content-length") ?? "")
        : Number.NaN
    if (Number.isFinite(declared) && declared > maxBytes) {
      await res.body?.cancel().catch(() => {})
      return { ok: false, kind: "body", status, error: new JsonBodyTooLargeError(maxBytes) }
    }
    const body = res.body
    if (!body || typeof body.getReader !== "function") {
      try {
        return { ok: true, status, json: (await res.json()) as T }
      } catch (error) {
        return { ok: false, kind: "body", status, error }
      }
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
            return { ok: false, kind: "body", status, error: new JsonBodyTooLargeError(maxBytes) }
          }
          chunks.push(value)
        }
      }
    } catch (error) {
      return { ok: false, kind: "body", status, error }
    } finally {
      reader.releaseLock?.()
    }
    try {
      const buf = new Uint8Array(total)
      let offset = 0
      for (const c of chunks) {
        buf.set(c, offset)
        offset += c.byteLength
      }
      return { ok: true, status, json: JSON.parse(new TextDecoder().decode(buf)) as T }
    } catch (error) {
      return { ok: false, kind: "body", status, error }
    }
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchJsonOrNull<T>(url: string, opts: FetchJsonOptions): Promise<T | null> {
  const result = await fetchJsonWithTimeout<T>(url, opts)
  return result.ok ? result.json : null
}
