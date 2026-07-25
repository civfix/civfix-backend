/**
 * ONE outbound-HTTP-with-deadline primitive for the vendor adapters (Photon, Mapbox, Census, Expo push,
 * Turnstile). Each of those had its own copy of "AbortController + setTimeout(abort) + clearTimeout in
 * finally + res.ok gate + guarded res.json()", and the copies had already drifted (redirect:"error" set in
 * some but not all; different treatment of a 200 with a non-JSON body). Drift in this exact code is a
 * security matter — `redirect:"error"` is the SSRF guard on a compromised/MITM upstream, and a missing
 * deadline stalls the report-submit and auth hot paths — so it lives in one place.
 *
 * The result is a DISCRIMINATED UNION rather than `T | null`: the callers deliberately have different
 * error taxonomies (best-effort geocoders fail OPEN to null; Turnstile fails CLOSED with an AppError; the
 * push dispatcher logs the HTTP status and retries a 429/5xx), and each needs to tell "transport failed"
 * from "non-2xx" from "unparseable body". `fetchJsonOrNull` is the fail-open wrapper for the geocoders.
 *
 * The deadline covers the BODY READ as well as the response headers: a socket that dribbles bytes forever
 * is the same stall as one that never answers.
 */

/** Outcome of one bounded JSON request. */
export type FetchJsonResult<T> =
  /** 2xx (per `res.ok`) with a successfully parsed JSON body. */
  | { ok: true; status: number; json: T }
  /** Non-2xx response. The body is not parsed — it is discarded (cancelled), not left dangling. */
  | { ok: false; kind: "http"; status: number }
  /** Network failure, DNS failure, refused redirect, or the deadline aborting the request. */
  | { ok: false; kind: "transport"; error: unknown }
  /** 2xx whose body did not parse as JSON. */
  | { ok: false; kind: "body"; status: number; error: unknown }

export interface FetchJsonOptions {
  /** Hard deadline for the whole request INCLUDING the body read. */
  timeoutMs: number
  /**
   * Injected fetch (tests). Resolved at CALL time so a test that swaps `globalThis.fetch` after the
   * adapter was constructed still sees its stub.
   */
  fetchImpl?: typeof fetch
  /**
   * Extra request init. `signal` is always overridden by the deadline controller, and `redirect` defaults
   * to "error" (an upstream must not be able to 30x us into an internal address).
   */
  init?: Omit<RequestInit, "signal">
}

/**
 * Perform a JSON request bounded by `timeoutMs`. NEVER throws: every failure mode is returned as a
 * non-ok result so the caller decides whether to fail open or closed.
 */
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
    // Test doubles hand back bare `{ ok, json }` objects with no status; normalize rather than lie about
    // the type.
    const status = typeof res.status === "number" ? res.status : 0
    if (!res.ok) {
      // Discard the error body so undici releases the socket NOW rather than whenever the response gets
      // GC'd. Nobody reads a non-2xx body here, and these callers are the ones that see 429/5xx storms
      // (Turnstile, Photon, Mapbox, Census, Expo push) — exactly when retaining connections hurts most.
      // Mirrors media-worker/src/download.ts. `?.` because test doubles hand back bare `{ ok, json }`.
      await res.body?.cancel().catch(() => {})
      return { ok: false, kind: "http", status }
    }
    try {
      return { ok: true, status, json: (await res.json()) as T }
    } catch (error) {
      return { ok: false, kind: "body", status, error }
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Fail-OPEN variant for best-effort lookups (the reverse geocoders, the Census jurisdiction lookup): any
 * failure — transport, non-2xx, or an unparseable body — collapses to null so the caller falls back
 * instead of failing the request it is decorating.
 */
export async function fetchJsonOrNull<T>(url: string, opts: FetchJsonOptions): Promise<T | null> {
  const result = await fetchJsonWithTimeout<T>(url, opts)
  return result.ok ? result.json : null
}
