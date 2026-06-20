/**
 * Thin GlitchTip/Sentry initialization, with PII scrubbing before send.
 *
 * GlitchTip is Sentry-API-compatible, so we use @sentry/node. This is a NO-OP when no DSN is set:
 * `initErrorReporting` returns false and `captureError` does nothing. The Sentry SDK is referenced
 * via `import type` only so the module typechecks without the runtime; the real init dynamically
 * imports it when a DSN is present.
 *
 * PRIVACY (documents/21-privacy-compliance.md §7.7): error payloads can otherwise capture request
 * bodies (report title/description, precise lat/long, email), auth headers/cookies, OTP codes, and
 * session tokens. We send NO default PII (`sendDefaultPii: false`) and additionally run a `beforeSend`
 * + `beforeBreadcrumb` scrubber that strips request data/headers/cookies/query strings, drops the user
 * record, and redacts known PII-shaped values (email/auth/token/OTP/lat/long/...) anywhere in the event.
 * The scrubbers are pure exported functions (`scrubEvent` / `scrubBreadcrumb`) so the behavior is
 * unit-testable without the SDK runtime.
 *
 * This module is the SINGLE error-reporting init for BOTH services: the media-worker imports
 * `initErrorReporting` / `captureError` / `flushErrorReporting` from `@civfix/api/errors`, so the
 * scrubbing here applies to the worker too.
 *
 * Seam-ish: @sentry/node is confined to this file plus the http-mapper that calls captureError.
 */

import type * as SentryNode from "@sentry/node"

type SentryModule = typeof SentryNode

/** The Sentry event/breadcrumb shapes we touch. Kept structural so we do not depend on the SDK runtime. */
type SentryEventLike = Record<string, unknown> & {
  request?: Record<string, unknown> | undefined
  user?: unknown
  extra?: Record<string, unknown> | undefined
  contexts?: Record<string, unknown> | undefined
  breadcrumbs?: unknown
}
type SentryBreadcrumbLike = Record<string, unknown> & {
  category?: string | undefined
  data?: Record<string, unknown> | undefined
  message?: unknown
}

let sentry: SentryModule | undefined
let enabled = false

export interface ErrorReportingOptions {
  dsn?: string
  environment?: string
  release?: string
}

/** The placeholder a redacted value is replaced with. */
const REDACTED = "[redacted]"

/**
 * Object keys whose VALUES are dropped wholesale (case-insensitive substring match). Covers auth, the
 * report free-text fields, precise coordinates, OTP/codes, and raw tokens. Matching is substring-based so
 * e.g. `authorization`, `x-csrf-token`, `set-cookie`, `latitude`, `geom` all hit.
 */
const SENSITIVE_KEY_PATTERNS: readonly string[] = [
  "authorization",
  "cookie",
  "token",
  "password",
  "secret",
  "session",
  "csrf",
  "otp",
  "code",
  "email",
  "description",
  "title",
  "body",
  "lat",
  "lng",
  "lon",
  "geom",
  "coord",
  "address",
  "addr",
  "phone",
  "apikey",
  "api-key",
  "api_key",
  "bearer",
]

/** True when an object key looks sensitive (its value should be redacted). */
function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase()
  return SENSITIVE_KEY_PATTERNS.some((p) => k.includes(p))
}

/**
 * Recursively redact sensitive values in a plain object/array, returning a NEW structure (never mutates
 * the input). Depth-bounded so a pathological/cyclic structure cannot blow the stack. Strings/numbers at
 * a sensitive key become `[redacted]`; everything else is walked.
 */
function deepRedact(value: unknown, depth = 0): unknown {
  if (depth > 8 || value === null || value === undefined) return value
  if (Array.isArray(value)) return value.map((v) => deepRedact(v, depth + 1))
  if (typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSensitiveKey(k) ? REDACTED : deepRedact(v, depth + 1)
    }
    return out
  }
  return value
}

/**
 * Strip the request envelope of an event: drop headers, cookies, body data, and query string entirely;
 * keep only a coarse method + path (with any query string lopped off) for debugging. Pure: returns a new
 * request object.
 */
function scrubRequest(req: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (typeof req.method === "string") out.method = req.method
  if (typeof req.url === "string") {
    // Keep only the path before "?"; the query string can carry search text / tokens.
    out.url = req.url.split("?")[0]
  }
  // headers, cookies, data, query_string, env are dropped entirely (they carry auth + PII).
  return out
}

/**
 * Scrub a Sentry event before it is sent. Removes the user record, strips the request envelope, lops
 * query strings off any url field, and deep-redacts `extra`/`contexts`/`tags`. PURE — returns a new
 * event; never mutates the input. Exported for unit testing.
 */
export function scrubEvent<T extends SentryEventLike>(event: T): T {
  const out = { ...event } as SentryEventLike

  // Drop the user record (id/ip/email/username). We never want it in error logs.
  if ("user" in out) delete out.user

  // Strip the request envelope (headers/cookies/body/query).
  if (out.request && typeof out.request === "object") {
    out.request = scrubRequest(out.request)
  }

  // Lop the query string off a top-level transaction/url if present.
  if (typeof (out as Record<string, unknown>).transaction === "string") {
    const t = (out as Record<string, unknown>).transaction as string
    ;(out as Record<string, unknown>).transaction = t.split("?")[0]
  }

  // Deep-redact the free-form blobs that our captureError() context + any integration fill in.
  if (out.extra && typeof out.extra === "object") {
    out.extra = deepRedact(out.extra) as Record<string, unknown>
  }
  if (out.contexts && typeof out.contexts === "object") {
    out.contexts = deepRedact(out.contexts) as Record<string, unknown>
  }
  if ("tags" in out && out.tags && typeof out.tags === "object") {
    ;(out as Record<string, unknown>).tags = deepRedact(out.tags)
  }

  // Drop captured breadcrumbs wholesale (HTTP breadcrumbs carry URLs/query; cheaper + safer to omit).
  if ("breadcrumbs" in out) delete out.breadcrumbs

  return out as T
}

/**
 * Scrub a breadcrumb before it is recorded. We drop HTTP/fetch breadcrumbs (their url/data carry query
 * strings + bodies) by returning null, and deep-redact the `data` of anything else we keep. PURE.
 * Returns null to DROP the breadcrumb. Exported for unit testing.
 */
export function scrubBreadcrumb<T extends SentryBreadcrumbLike>(crumb: T): T | null {
  const category = typeof crumb.category === "string" ? crumb.category.toLowerCase() : ""
  // HTTP/fetch/query breadcrumbs are the highest-PII (URLs + bodies); drop them entirely.
  if (category === "http" || category === "fetch" || category === "xhr" || category.includes("query")) {
    return null
  }
  const out = { ...crumb } as SentryBreadcrumbLike
  if (out.data && typeof out.data === "object") {
    out.data = deepRedact(out.data) as Record<string, unknown>
  }
  return out as T
}

/**
 * Initialize error reporting. Returns true if a real reporter was enabled, false if disabled
 * (no DSN). Never throws: a failure to load the SDK degrades to no-op and is logged.
 */
export async function initErrorReporting(opts: ErrorReportingOptions): Promise<boolean> {
  if (!opts.dsn) {
    enabled = false
    return false
  }
  try {
    const mod = (await import("@sentry/node")) as SentryModule
    mod.init({
      dsn: opts.dsn,
      environment: opts.environment,
      release: opts.release,
      tracesSampleRate: 0,
      // PRIVACY: never attach default PII (ip, cookies, user, request body/headers). This is the
      // primary switch; the beforeSend/beforeBreadcrumb scrubbers below are belt-and-suspenders for any
      // PII an integration still manages to attach (e.g. captureError context, request envelope).
      sendDefaultPii: false,
      beforeSend: (event) => scrubEvent(event as unknown as SentryEventLike) as never,
      beforeBreadcrumb: (crumb) =>
        scrubBreadcrumb(crumb as unknown as SentryBreadcrumbLike) as never,
    })
    sentry = mod
    enabled = true
    return true
  } catch (err) {
    // Do not crash the app because telemetry failed to load; surface it loudly instead.
    enabled = false
    console.error("initErrorReporting: failed to load @sentry/node, continuing without it:", err)
    return false
  }
}

/** Whether error reporting is currently enabled. */
export function isErrorReportingEnabled(): boolean {
  return enabled
}

/**
 * Report an error to GlitchTip/Sentry. No-op when reporting is disabled. `context` is attached as
 * extra data (e.g. requestId, route) — it is deep-redacted by `scrubEvent` before send, so a caller that
 * accidentally threads PII into the context cannot leak it.
 */
export function captureError(err: unknown, context?: Record<string, unknown>): void {
  if (!enabled || !sentry) return
  sentry.captureException(err, context ? { extra: context } : undefined)
}

/** Flush buffered events on shutdown. No-op when disabled. */
export async function flushErrorReporting(timeoutMs = 2000): Promise<void> {
  if (!enabled || !sentry) return
  try {
    await sentry.flush(timeoutMs)
  } catch (err) {
    console.error("flushErrorReporting: flush failed:", err)
  }
}
