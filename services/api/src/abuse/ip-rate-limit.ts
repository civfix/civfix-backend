/**
 * Per-IP hourly rate limit for anonymous report submission.
 *
 * IPv4 (including IPv4-mapped ::ffff:a.b.c.d) is bucketed by its full address, so one NAT is one bucket.
 * IPv6 is bucketed by its /64 prefix: an ISP hands a customer a whole /64 and an abuser can rotate the low
 * 64 bits freely, so counting the /64 stops that evasion without over-penalizing a dual-stack user.
 */

import { AppError } from "@civfix/shared"
import { expandIpv6Hextets } from "../adapters/net-ipv6.js"
import type { CounterStore } from "./counter-store.js"

export const IP_HARD_LIMIT_PER_HOUR = 10

const IP_WINDOW_SECONDS = 60 * 60

const IP_COUNTER_PREFIX = "abuse:ip:"

const IPV6_PREFIX_HEXTETS = 4

const UNKNOWN_IP_BUCKET = "unknown"

const IPV4_MAPPED_IPV6_RE = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/

const IPV4_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/

const LEADING_ZEROS_RE = /^0+(?=.)/

/** A missing IP normalizes to a stable "unknown" bucket so it is still limited instead of bypassing. */
export function normalizeIp(ip: string | undefined | null): string {
  const raw = (ip ?? "").trim().toLowerCase()
  if (raw === "") return UNKNOWN_IP_BUCKET

  const mapped = IPV4_MAPPED_IPV6_RE.exec(raw)
  if (mapped) return mapped[1]!

  if (IPV4_RE.test(raw)) return raw

  if (raw.includes(":")) {
    return ipv6Prefix64(raw)
  }

  return raw
}

function ipv6Prefix64(addr: string): string {
  // A malformed address is not rejected: it yields whatever prefix its hextets imply, because the limiter
  // must bucket every input rather than let a garbage IP through uncounted.
  const { hextets } = expandIpv6Hextets(addr)

  const prefix: string[] = []
  for (let i = 0; i < IPV6_PREFIX_HEXTETS; i++) {
    const h = hextets[i] ?? "0"
    const trimmed = h.replace(LEADING_ZEROS_RE, "")
    prefix.push(trimmed === "" ? "0" : trimmed)
  }
  return `${prefix.join(":")}::/64`
}

// The hard cap for every IP today: no GeoIP/ASN database ships. This is the one place to wire an ASN
// lookup that grants a higher cap to known-clean residential or shared-NAT ranges.
export function classifyIpAllowance(_normalizedIp: string): number {
  return IP_HARD_LIMIT_PER_HOUR
}

export interface IpRateLimitDeps {
  counters: CounterStore
  limitFor?: (normalizedIp: string) => number
}

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
