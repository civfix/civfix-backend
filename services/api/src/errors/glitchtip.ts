
import type * as SentryNode from "@sentry/node"

type SentryModule = typeof SentryNode

type SentryEventLike = Record<string, unknown> & {
  request?: Record<string, unknown> | undefined
  user?: unknown
  extra?: Record<string, unknown> | undefined
  contexts?: Record<string, unknown> | undefined
  breadcrumbs?: unknown
  exception?: unknown
  message?: unknown
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

const REDACTED = "[redacted]"

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

function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase()
  return SENSITIVE_KEY_PATTERNS.some((p) => k.includes(p))
}

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

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
const BEARER_RE = /\bBearer\s+[\w.-]+/gi
const SECRET_ASSIGN_RE =
  /\b(access_token|refresh_token|token|password|passwd|secret|api[_-]?key|authorization|auth|otp)\b(\s*[=:]\s*)([^\s,;&"']+)/gi
const MAX_MESSAGE_LEN = 2000

function scrubMessage(text: string): string {
  const redacted = text
    .replace(EMAIL_RE, REDACTED)
    .replace(BEARER_RE, `Bearer ${REDACTED}`)
    .replace(SECRET_ASSIGN_RE, (_m, key: string, sep: string) => `${key}${sep}${REDACTED}`)
  return redacted.length > MAX_MESSAGE_LEN ? `${redacted.slice(0, MAX_MESSAGE_LEN)}...` : redacted
}

function scrubExceptionValues(exception: unknown): unknown {
  if (!exception || typeof exception !== "object") return exception
  const values = (exception as Record<string, unknown>).values
  if (!Array.isArray(values)) return exception
  return {
    ...(exception as Record<string, unknown>),
    values: values.map((v) =>
      v && typeof v === "object" && typeof (v as Record<string, unknown>).value === "string"
        ? {
            ...(v as Record<string, unknown>),
            value: scrubMessage((v as Record<string, unknown>).value as string),
          }
        : v,
    ),
  }
}

function scrubRequest(req: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (typeof req.method === "string") out.method = req.method
  if (typeof req.url === "string") {
    out.url = req.url.split("?")[0]
  }
  return out
}

export function scrubEvent<T extends SentryEventLike>(event: T): T {
  const out = { ...event } as SentryEventLike

  if ("user" in out) delete out.user

  if (out.request && typeof out.request === "object") {
    out.request = scrubRequest(out.request)
  }

  if (typeof (out as Record<string, unknown>).transaction === "string") {
    const t = (out as Record<string, unknown>).transaction as string
    ;(out as Record<string, unknown>).transaction = t.split("?")[0]
  }

  if (out.extra && typeof out.extra === "object") {
    out.extra = deepRedact(out.extra) as Record<string, unknown>
  }
  if (out.contexts && typeof out.contexts === "object") {
    out.contexts = deepRedact(out.contexts) as Record<string, unknown>
  }
  if ("tags" in out && out.tags && typeof out.tags === "object") {
    ;(out as Record<string, unknown>).tags = deepRedact(out.tags)
  }

  if ("breadcrumbs" in out) delete out.breadcrumbs

  if (typeof out.message === "string") {
    out.message = scrubMessage(out.message)
  }
  if (out.exception !== undefined) {
    out.exception = scrubExceptionValues(out.exception)
  }

  return out as T
}

export function scrubBreadcrumb<T extends SentryBreadcrumbLike>(crumb: T): T | null {
  const category = typeof crumb.category === "string" ? crumb.category.toLowerCase() : ""
  if (category === "http" || category === "fetch" || category === "xhr" || category.includes("query")) {
    return null
  }
  const out = { ...crumb } as SentryBreadcrumbLike
  if (out.data && typeof out.data === "object") {
    out.data = deepRedact(out.data) as Record<string, unknown>
  }
  return out as T
}

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
      sendDefaultPii: false,
      beforeSend: (event) => scrubEvent(event as unknown as SentryEventLike) as never,
      beforeBreadcrumb: (crumb) =>
        scrubBreadcrumb(crumb as unknown as SentryBreadcrumbLike) as never,
    })
    sentry = mod
    enabled = true
    return true
  } catch (err) {
    enabled = false
    console.error("initErrorReporting: failed to load @sentry/node, continuing without it:", err)
    return false
  }
}

export function isErrorReportingEnabled(): boolean {
  return enabled
}

export function captureError(err: unknown, context?: Record<string, unknown>): void {
  if (!enabled || !sentry) return
  sentry.captureException(err, context ? { extra: context } : undefined)
}

export async function flushErrorReporting(timeoutMs = 2000): Promise<void> {
  if (!enabled || !sentry) return
  try {
    await sentry.flush(timeoutMs)
  } catch (err) {
    console.error("flushErrorReporting: flush failed:", err)
  }
}
