/**
 * Security: with `trustProxy: true` Fastify trusts ANY upstream and takes the client-spoofable LEFTMOST
 * X-Forwarded-For entry as `request.ip`, which unwinds every per-IP control and poisons the audit trail.
 * The default trusts only loopback + RFC1918 + unique-local ranges. Pairs with the Caddyfile in
 * civfix-infra, which SETS (not appends) X-Forwarded-For so a client cannot pre-seed even the trusted hop.
 */

export { parseTrustProxy, DEFAULT_TRUSTED_PROXY_CIDRS } from "../env/parsers.js"
