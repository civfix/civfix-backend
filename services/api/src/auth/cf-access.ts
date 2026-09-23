/**
 * Cloudflare Access JWT verifier for the admin Access exchange (`/admin/auth/access/exchange`), which reads
 * the `Cf-Access-Jwt-Assertion` header Cloudflare adds after an Access login.
 *
 * Checking the header's presence is not enough: a forged token would elevate to operator. The RS256
 * signature is verified against Cloudflare's published JWKS along with `iss`, `aud` and `exp`, and the
 * algorithm is pinned to prevent alg-confusion. The edge Access app and the firewall-locked tunnel are the
 * complementary controls, in deployment.
 *
 * The JWKS is created once per verifier, never per request: it caches keys and refetches on an unknown
 * `kid`, which handles Cloudflare's key rotation.
 */

import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose"

export interface AccessIdentity {
  /** Verified email for an interactive (human) login; null for a service-token (machine) login. */
  email: string | null
  /** The service-token client id (`common_name`) for a machine login; null for a human login. */
  commonName: string | null
  /** Cloudflare's stable user id for the identity ("" for service tokens). */
  sub: string
  raw: JWTPayload
}

export interface AccessVerifierConfig {
  /**
   * The expected JWT `iss` and the JWKS base, e.g. `https://civfix.cloudflareaccess.com`. A trailing slash
   * is trimmed.
   */
  teamDomain: string
  /** The Application Audience (AUD) tag of the path-scoped Access app on api.civfix.org/admin. */
  aud: string
}

/** Throws (from jose) on any validation failure. */
export type VerifyAccessJwt = (token: string) => Promise<AccessIdentity>

/**
 * `jwks` exists for offline unit tests; production omits it and fetches the auto-rotating remote set from
 * the team's `/cdn-cgi/access/certs`.
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
      // jose validates iss/aud/exp only when present; without this a token omitting exp would skip the
      // expiry check.
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
