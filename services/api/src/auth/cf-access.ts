/**
 * Cloudflare Access (Zero Trust) JWT verifier (doc 16 §6.2).
 *
 * After a user authenticates at the Cloudflare Access login, Cloudflare proxies each request to the
 * origin with a per-account-signed JWT in the `Cf-Access-Jwt-Assertion` header. The admin Access
 * exchange route (`/admin/auth/access/exchange`) reads that header and calls the verifier built here to
 * confirm the token before minting an operator session.
 *
 * SECURITY: checking the header's PRESENCE is not enough — a forged/altered token would otherwise let an
 * attacker elevate to operator. This verifier cryptographically validates the RS256 signature against
 * Cloudflare's published JWKS and checks `iss` (team domain), `aud` (the per-app AUD tag), and `exp`.
 * The algorithm is pinned to RS256 to prevent alg-confusion. The complementary controls (the Access app
 * at the edge + the firewall-locked cloudflared tunnel) live in deployment, not in this file.
 *
 * The JWKS is created ONCE per verifier (it caches keys and refetches on an unknown `kid`, handling
 * Cloudflare's key rotation) — never per request. The key resolver is injectable so unit tests can serve
 * a locally generated key set (`createLocalJWKSet`) with no network.
 */

import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose"

/** The verified identity carried by an Access JWT. */
export interface AccessIdentity {
  /** Verified email for an interactive (human) login; null for a service-token (machine) login. */
  email: string | null
  /** The service-token client id (`common_name`) for a machine login; null for a human login. */
  commonName: string | null
  /** Cloudflare's stable user id for the identity ("" for service tokens). */
  sub: string
  /** The raw verified payload, for any claim not surfaced above. */
  raw: JWTPayload
}

export interface AccessVerifierConfig {
  /**
   * The team Access domain — the expected JWT `iss` and the JWKS base, e.g.
   * `https://civfix.cloudflareaccess.com`. A trailing slash, if present, is trimmed.
   */
  teamDomain: string
  /** The Application Audience (AUD) tag of the path-scoped Access app on api.civfix.org/admin. */
  aud: string
}

/** Verify a Cloudflare Access JWT and return its identity; throws (jose) on any validation failure. */
export type VerifyAccessJwt = (token: string) => Promise<AccessIdentity>

/**
 * Build an Access JWT verifier. `jwks` is injectable purely for offline unit tests (production omits it
 * and a remote, auto-rotating JWKS is fetched from the team's `/cdn-cgi/access/certs`).
 */
export function createAccessVerifier(
  config: AccessVerifierConfig,
  jwks?: JWTVerifyGetKey,
): VerifyAccessJwt {
  const issuer = config.teamDomain.replace(/\/+$/, "")
  const keySet = jwks ?? createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`))

  return async function verifyAccessJwt(token: string): Promise<AccessIdentity> {
    const { payload } = await jwtVerify(token, keySet, {
      issuer,
      audience: config.aud,
      algorithms: ["RS256"], // pin to prevent alg-confusion
      clockTolerance: 30, // seconds; tolerate minor clock drift
      // Require the claims to be PRESENT (jose validates iss/aud/exp values, but without this a token
      // omitting exp would skip the expiry check). Makes the in-app validation match doc 16 §4.1/§6.3.
      requiredClaims: ["exp", "iss", "aud"],
    })
    return {
      email: typeof payload.email === "string" ? payload.email : null,
      commonName: typeof payload.common_name === "string" ? payload.common_name : null,
      sub: typeof payload.sub === "string" ? payload.sub : "",
      raw: payload,
    }
  }
}
