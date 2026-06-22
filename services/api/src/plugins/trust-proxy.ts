/**
 * Trusted-proxy resolution for Fastify's `trustProxy` option.
 *
 * The pure parser now lives in env/parsers.ts (it is an env parser, not a Fastify plugin); this module
 * re-exports it so existing importers/tests keep resolving.
 *
 * SECURITY: Fastify derives `request.ip` (and `request.protocol`/`request.hostname`) from X-Forwarded-*
 * headers ONLY for hops it is told to trust. With `trustProxy: true` it trusts ANY upstream and reads the
 * LEFTMOST X-Forwarded-For entry as the client — which a client can spoof. That single misconfiguration
 * unwinds every per-IP control (the global limiter, the anon per-IP submit cap, the OTP per-IP cap) and
 * poisons the audit trail (sessions.ip / abuse logs). The default trusts ONLY the internal loopback +
 * RFC1918 + unique-local ranges, so a forged X-Forwarded-For from a real internet client is never honored
 * while the value Caddy sets for the true client IS. Pairs with infra/caddy/Caddyfile, which SETS (not
 * appends) X-Forwarded-For and strips any inbound XFF so the client cannot pre-seed even the trusted hop.
 */

export {
  parseTrustProxy,
  DEFAULT_TRUSTED_PROXY_CIDRS,
  type TrustProxyValue,
} from "../env/parsers.js"
