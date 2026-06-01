/**
 * Trusted-proxy resolution for Fastify's `trustProxy` option.
 *
 * SECURITY: Fastify derives `request.ip` (and `request.protocol`/`request.hostname`) from the
 * X-Forwarded-* headers ONLY for hops it is told to trust. With `trustProxy: true` it trusts ANY
 * upstream, so it reads the LEFTMOST X-Forwarded-For entry as the client - which a client can spoof by
 * sending its own X-Forwarded-For header. That single misconfiguration unwinds every per-IP control
 * (the global limiter, the anon per-IP submit cap, and the OTP per-IP cap), and poisons the audit
 * trail (sessions.ip / abuse logs) with attacker-chosen values.
 *
 * The fix is to trust ONLY the known proxy in front of the API. We accept three forms via the
 * TRUST_PROXY env var, parsed here (PURE, so it is unit-testable):
 *
 *   - a non-negative INTEGER ("1", "2", ...): trust exactly that many hops. Fastify then takes the
 *     (N+1)-th X-Forwarded-For entry from the RIGHT, i.e. the value the trusted proxy actually set, not
 *     the client's injected leftmost one. Use "1" when only Caddy fronts the API.
 *   - a COMMA LIST of CIDRs / IPs ("10.0.0.0/8,127.0.0.1"): trust X-Forwarded-* ONLY when the immediate
 *     peer's address is inside one of those ranges. XFF from any other source is ignored and
 *     `request.ip` falls back to the real socket peer. This is the most robust form because it does not
 *     depend on a fixed hop count.
 *   - the literals "true" / "false": trust all (UNSAFE; only for a trusted private network) / trust none
 *     (read the raw socket peer; correct when the API is exposed directly with no proxy).
 *
 * DEFAULT (TRUST_PROXY unset): the loopback + RFC1918 private + unique-local ranges. In the deployed
 * topology the API only ever receives connections from Caddy on the internal Docker/private network, so
 * trusting those source ranges (and nothing public) means a forged X-Forwarded-For from a real internet
 * client is never honored, while the value Caddy sets for the true client IS. This default is safe in
 * production and convenient in dev (loopback is trusted), so no env is required to be correct.
 *
 * Pairs with infra/caddy/Caddyfile, which SETS (not appends) X-Forwarded-For to the real remote and
 * strips any inbound XFF, so the client cannot pre-seed the header even for the trusted hop.
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

  // A bare non-negative integer is a hop count.
  if (/^\d+$/.test(value)) {
    const n = Number.parseInt(value, 10)
    if (Number.isSafeInteger(n) && n >= 0) return n
    return [...DEFAULT_TRUSTED_PROXY_CIDRS]
  }

  // Otherwise treat it as a comma list of CIDRs / IPs.
  const cidrs = value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  return cidrs.length > 0 ? cidrs : [...DEFAULT_TRUSTED_PROXY_CIDRS]
}
