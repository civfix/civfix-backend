/**
 * Pure env-string parsers for the API config loader. Zero runtime imports beyond the trust-proxy
 * value type so this module is trivially unit-testable. env.ts composes these into a typed `Env`.
 */

/** The value type Fastify accepts for its `trustProxy` option (the subset we produce). */
export type TrustProxyValue = boolean | number | string[]

/**
 * Loopback + private (RFC1918) + IPv6 loopback/unique-local ranges. The safe default set of proxy
 * sources to trust when TRUST_PROXY is unset: only an upstream on the internal network is honored.
 */
export const DEFAULT_TRUSTED_PROXY_CIDRS: readonly string[] = [
  "127.0.0.1/8",
  "::1/128",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "fc00::/7",
]

/** Parse "1"/"true"/"yes"/"on" (case-insensitive) as true; everything else false. */
export function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === "") return fallback
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase())
}

/** Split a comma list into a trimmed, non-empty array. */
export function parseCsv(raw: string | undefined): string[] {
  if (!raw) return []
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/** Like parseCsv but lowercased + de-duplicated (used for the case-insensitive ADMIN_EMAILS allowlist). */
export function parseCsvLower(raw: string | undefined): string[] {
  const seen = new Set<string>()
  for (const item of parseCsv(raw)) {
    seen.add(item.toLowerCase())
  }
  return [...seen]
}

/** Parse an integer from an env string, falling back when blank/non-finite. */
export function parseIntOr(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback
  const n = Number.parseInt(raw.trim(), 10)
  return Number.isFinite(n) ? n : fallback
}

/**
 * Parse a positive integer, clamping to >= 1 and falling back on blank/non-finite/non-positive input.
 * Used for [OPT] timeouts/windows where a 0 or negative value would silently disable a guard.
 */
export function parsePositiveIntOr(raw: string | undefined, fallback: number): number {
  const n = parseIntOr(raw, fallback)
  return n >= 1 ? n : fallback
}

/**
 * Hard ceiling for SHUTDOWN_DRAIN_MS (the SIGTERM drain window, lifecycle.ts).
 *
 * The drain is SERIAL with the 20s close watchdog, and the whole shutdown must finish inside the
 * container's `stop_grace_period` or Docker SIGKILLs the process mid-teardown (pg-boss workers killed
 * mid-job, handles dropped). The blue/green compose sets that to 45s, so 20 + 20 = 40s leaves 5s of
 * margin whatever value is configured.
 */
export const SHUTDOWN_DRAIN_MS_MAX = 20_000

/**
 * Parse the SIGTERM drain window. The default is 0 — NO drain — in every environment, deliberately:
 * a drain longer than the container's `stop_grace_period` is strictly worse than no drain at all, and
 * that grace period lives in civfix-infra. The value is therefore switched on where the grace period
 * is set (the compose api service `environment:` block, next to `stop_grace_period: 45s`), so the two
 * cannot drift apart or land in different deploys. A negative or non-numeric value falls back to 0;
 * anything above the ceiling is clamped rather than rejected.
 */
export function parseDrainMs(raw: string | undefined): number {
  const n = parseIntOr(raw, 0)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.min(n, SHUTDOWN_DRAIN_MS_MAX)
}

/** Parse a "west,south,east,north" bounds string; falls back unless it is exactly four finite numbers. */
export function parseBounds(
  raw: string | undefined,
  fallback: [number, number, number, number],
): [number, number, number, number] {
  if (raw === undefined || raw.trim() === "") return fallback
  const parts = raw.split(",").map((s) => Number.parseFloat(s.trim()))
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return fallback
  return [parts[0]!, parts[1]!, parts[2]!, parts[3]!]
}

/**
 * Cheap structural validity check for a 5- or 6-field cron expression (minute hour dom month dow, with
 * an optional leading seconds field). Only the field count + a permissive per-field charset are checked
 * so a typo is caught at boot rather than failing the pg-boss scheduler AFTER listen(). It does NOT
 * validate ranges — the scheduler owns full parsing.
 */
export function isCronish(raw: string | undefined): boolean {
  if (raw === undefined) return false
  const fields = raw.trim().split(/\s+/).filter((f) => f.length > 0)
  if (fields.length !== 5 && fields.length !== 6) return false
  // Allow letters too (named months/days-of-week like JAN, MON, MON-FRI, plus L/W) — the scheduler
  // (pg-boss/cron-parser) owns full validation; this only catches gross typos (wrong field count / junk).
  return fields.every((f) => /^[\dA-Za-z*/,\-?#]+$/.test(f))
}

/**
 * Parse the TRUST_PROXY env value into a Fastify `trustProxy` setting. PURE.
 *
 *   undefined / ""        -> DEFAULT_TRUSTED_PROXY_CIDRS (safe: trust only internal proxy sources)
 *   "true" / "false"      -> the literal boolean
 *   a non-negative int    -> that hop count (number)
 *   a comma list otherwise -> the trimmed CIDR/IP entries (string[])
 *
 * A blank/garbage value falls back to the safe default rather than throwing, so a typo never makes the
 * API trust everything.
 */
export function parseTrustProxy(raw: string | undefined): TrustProxyValue {
  if (raw === undefined) return [...DEFAULT_TRUSTED_PROXY_CIDRS]
  const value = raw.trim()
  if (value === "") return [...DEFAULT_TRUSTED_PROXY_CIDRS]

  const lower = value.toLowerCase()
  if (lower === "true") return true
  if (lower === "false") return false

  // A bare non-negative integer is a hop count; Fastify then takes the (N+1)-th X-Forwarded-For entry
  // from the RIGHT, i.e. the value the trusted proxy set, not the client's injected leftmost one.
  if (/^\d+$/.test(value)) {
    const n = Number.parseInt(value, 10)
    if (Number.isSafeInteger(n) && n >= 0) return n
    return [...DEFAULT_TRUSTED_PROXY_CIDRS]
  }

  const cidrs = value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  return cidrs.length > 0 ? cidrs : [...DEFAULT_TRUSTED_PROXY_CIDRS]
}
