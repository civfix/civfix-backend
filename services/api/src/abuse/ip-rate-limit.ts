/**
 * Per-IP hourly rate limit for anonymous report submission. `normalizeIp` (pure) collapses a client IP
 * to the bucket key; `enforceIpRateLimit` increments the hour-window counter and throws once the cap is
 * exceeded.
 *
 * BUCKET KEYING: IPv4 (incl. IPv4-mapped IPv6 ::ffff:a.b.c.d) is counted by its FULL address (one NAT =
 * one bucket). IPv6 is counted by the /64 PREFIX only: an ISP hands a customer a whole /64 and an abuser
 * can rotate the low 64 bits freely, so counting the /64 stops that evasion without over-penalizing a
 * legitimate dual-stack user.
 */

import { AppError } from "@civfix/shared"
import type { CounterStore } from "./counter-store.js"

/** Hard per-IP submissions-per-hour cap. Applies to every IP. */
export const IP_HARD_LIMIT_PER_HOUR = 10

/** Higher soft cap reserved for a future known-clean-ASN classifier; unused until `classifyIpAllowance` consults it. */
export const IP_SOFT_LIMIT_PER_HOUR = 50

/** Window length for the per-IP counter: one hour, in seconds. */
export const IP_WINDOW_SECONDS = 60 * 60

/** Redis key prefix for the per-IP hourly counter. */
const IP_COUNTER_PREFIX = "abuse:ip:"

/** Number of leading hextets that make up an IPv6 /64 prefix. */
const IPV6_PREFIX_HEXTETS = 4

/**
 * Collapse a raw client IP into the bucket key the limiter counts. PURE. See the file header for the
 * IPv4-full / IPv6-/64 rationale. An empty/garbage value normalizes to a stable "unknown" bucket so a
 * missing IP still rate-limits (rather than bypassing the limiter).
 */
export function normalizeIp(ip: string | undefined | null): string {
  const raw = (ip ?? "").trim().toLowerCase()
  if (raw === "") return "unknown"

  // IPv4-mapped IPv6 (::ffff:a.b.c.d) -> treat as the embedded IPv4 (full address).
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(raw)
  if (mapped) return mapped[1]!

  // Plain IPv4 -> the full dotted quad.
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(raw)) return raw

  // Otherwise treat as IPv6: reduce to the /64 prefix (first four hextets), expanding a "::" gap.
  if (raw.includes(":")) {
    return ipv6Prefix64(raw)
  }

  // Not recognizably an IP (hostname, etc.): use it verbatim as its own bucket.
  return raw
}

/** Expand a (possibly "::"-compressed) IPv6 address and return its /64 prefix as "h:h:h:h::/64". */
function ipv6Prefix64(addr: string): string {
  // Split on "::" to expand the zero-run, if present.
  const [headRaw, tailRaw] = addr.split("::") as [string, string | undefined]
  const head = headRaw === "" ? [] : headRaw.split(":")
  const tail = tailRaw === undefined ? null : tailRaw === "" ? [] : tailRaw.split(":")

  let hextets: string[]
  if (tail === null) {
    // No "::": the address is already full (or malformed); take what is there.
    hextets = head
  } else {
    const missing = Math.max(0, 8 - head.length - tail.length)
    hextets = [...head, ...Array(missing).fill("0"), ...tail]
  }

  // Take the first four hextets (the /64), normalizing each (drop leading zeros; empty -> "0").
  const prefix: string[] = []
  for (let i = 0; i < IPV6_PREFIX_HEXTETS; i++) {
    const h = hextets[i] ?? "0"
    const trimmed = h.replace(/^0+(?=.)/, "")
    prefix.push(trimmed === "" ? "0" : trimmed)
  }
  return `${prefix.join(":")}::/64`
}

// The per-IP cap. Returns the hard cap for every IP today; the single place to wire a real ASN lookup
// that grants IP_SOFT_LIMIT_PER_HOUR to known-clean residential/shared-NAT ranges (no GeoIP/ASN DB shipped).
export function classifyIpAllowance(_normalizedIp: string): number {
  return IP_HARD_LIMIT_PER_HOUR
}

export interface IpRateLimitDeps {
  counters: CounterStore
  /** Override the per-IP cap resolver (tests). Defaults to classifyIpAllowance (hard cap for all). */
  limitFor?: (normalizedIp: string) => number
}

/**
 * Enforce the per-IP hourly submission cap. Normalizes the IP, increments its hour-window counter, and
 * throws AppError.rateLimited (429) when the count EXCEEDS the cap. Returns the normalized IP + the
 * post-increment count so the caller can log/inspect. The Nth submission in a window is allowed; the
 * (cap+1)-th is rejected.
 */
export async function enforceIpRateLimit(
  ip: string | undefined | null,
  deps: IpRateLimitDeps,
): Promise<{ normalizedIp: string; count: number; limit: number }> {
  const normalizedIp = normalizeIp(ip)
  const limit = (deps.limitFor ?? classifyIpAllowance)(normalizedIp)
  const key = IP_COUNTER_PREFIX + normalizedIp
  const count = await deps.counters.incr(key, IP_WINDOW_SECONDS)
  if (count > limit) {
    throw AppError.rateLimited("Too many anonymous submissions from this network. Try again later.")
  }
  return { normalizedIp, count, limit }
}
