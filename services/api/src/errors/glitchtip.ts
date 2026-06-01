/**
 * Thin GlitchTip/Sentry initialization.
 *
 * GlitchTip is Sentry-API-compatible, so we use @sentry/node. This is a NO-OP when no DSN is set:
 * `initErrorReporting` returns false and `captureError` does nothing. The Sentry SDK is referenced
 * via `import type` only so the module typechecks without the runtime; the real init dynamically
 * imports it when a DSN is present.
 *
 * Seam-ish: @sentry/node is confined to this file plus the http-mapper that calls captureError.
 */

import type * as SentryNode from "@sentry/node"

type SentryModule = typeof SentryNode

let sentry: SentryModule | undefined
let enabled = false

export interface ErrorReportingOptions {
  dsn?: string
  environment?: string
  release?: string
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
 * extra data (e.g. requestId, route).
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
