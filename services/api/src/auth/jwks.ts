/**
 * ID-token verification against a provider JWKS (Apple / Google).
 *
 * Verifying a third-party ID token means: fetch the provider's JSON Web Key Set, pick the key whose
 * `kid` matches the token header, check the RS256 signature over `header.payload`, then validate the
 * standard claims (iss, aud, exp, and nbf when present). All of that lives here so the OAuth service
 * stays free of crypto/network detail and so tests can inject a stub `JwksVerifier`.
 *
 * The JWKS fetch is the only network call; results are cached in-process with a short TTL to avoid
 * hammering the provider. WebCrypto (`crypto.subtle`) does the signature check, importing the JWK
 * directly, so there is no third-party JWT library in the dependency graph.
 */

import { createHash, timingSafeEqual } from "node:crypto"
import { AppError } from "@civfix/shared"

/** The verified, trusted claims a caller may rely on after a successful verify. */
export interface VerifiedIdToken {
  /** Stable provider-scoped subject identifier (the account id). */
  sub: string
  /** Verified email, when the provider asserted one. */
  email: string | null
  /** Whether the provider marked the email verified (Apple/Google send this as a bool or string). */
  emailVerified: boolean
  /** Display name, when present (Google `name`). */
  name: string | null
}

export interface VerifyParams {
  /** Provider JWKS endpoint. */
  jwksUrl: string
  /** Acceptable `iss` values (a provider may use more than one spelling). */
  issuers: string[]
  /** Expected `aud` (our OAuth client id). */
  audience: string
  /**
   * Optional expected `nonce` (P2-3 replay binding). When set, the token's `nonce` claim MUST match
   * either this raw value OR its SHA-256 hex (Apple's native Sign in with Apple stores SHA256(nonce) in
   * the claim). When unset, no nonce check is performed (the caller did not issue one).
   */
  expectedNonce?: string
  /** Override "now" (epoch seconds) for deterministic expiry tests. */
  nowSeconds?: number
}

/** The seam the OAuth service depends on; production uses RemoteJwksVerifier, tests pass a stub. */
export interface JwksVerifier {
  verify(idToken: string, params: VerifyParams): Promise<VerifiedIdToken>
}

/** Minimal JWK shape we consume (RSA signing keys). */
interface Jwk {
  kid?: string
  kty?: string
  alg?: string
  use?: string
  n?: string
  e?: string
}

interface JwtHeader {
  alg?: string
  kid?: string
  typ?: string
}

interface JwtClaims {
  iss?: string
  aud?: string | string[]
  sub?: string
  exp?: number
  nbf?: number
  nonce?: string
  email?: string
  email_verified?: boolean | string
  name?: string
}

/** Fetch function shape, injectable so the cache/fetch can be unit-tested without real network. */
export type FetchLike = (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>

export interface RemoteJwksVerifierOptions {
  /** Defaults to global fetch. */
  fetchImpl?: FetchLike
  /** JWKS cache TTL in ms (default 1 hour). */
  cacheTtlMs?: number
  now?: () => number
}

interface CachedJwks {
  keys: Jwk[]
  fetchedAtMs: number
}

/**
 * Real JWKS verifier: fetches + caches the key set and verifies RS256 with WebCrypto. Confines all
 * network + crypto for token verification to this class.
 */
export class RemoteJwksVerifier implements JwksVerifier {
  private readonly fetchImpl: FetchLike
  private readonly cacheTtlMs: number
  private readonly now: () => number
  private readonly cache = new Map<string, CachedJwks>()

  constructor(opts: RemoteJwksVerifierOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? defaultFetch
    this.cacheTtlMs = opts.cacheTtlMs ?? 60 * 60 * 1000
    this.now = opts.now ?? Date.now
  }

  async verify(idToken: string, params: VerifyParams): Promise<VerifiedIdToken> {
    const parts = idToken.split(".")
    if (parts.length !== 3) {
      throw AppError.unauthorized("Malformed identity token.")
    }
    const [headerB64, payloadB64, signatureB64] = parts as [string, string, string]

    const header = decodeJsonSegment<JwtHeader>(headerB64)
    if (!header || header.alg !== "RS256" || !header.kid) {
      throw AppError.unauthorized("Unsupported identity token algorithm.")
    }

    const jwk = await this.resolveKey(params.jwksUrl, header.kid)
    const valid = await verifyRs256(jwk, `${headerB64}.${payloadB64}`, signatureB64)
    if (!valid) {
      throw AppError.unauthorized("Identity token signature is invalid.")
    }

    const claims = decodeJsonSegment<JwtClaims>(payloadB64)
    if (!claims) {
      throw AppError.unauthorized("Malformed identity token payload.")
    }
    return validateClaims(claims, params, this.now)
  }

  /** Return the matching JWK for `kid`, fetching (and caching) the JWKS, with a one-shot refresh. */
  private async resolveKey(jwksUrl: string, kid: string): Promise<Jwk> {
    let keys = await this.getKeys(jwksUrl, false)
    let match = keys.find((k) => k.kid === kid)
    if (!match) {
      // Key rotation: force a refresh once before giving up.
      keys = await this.getKeys(jwksUrl, true)
      match = keys.find((k) => k.kid === kid)
    }
    if (!match) {
      throw AppError.unauthorized("Identity token key not found.")
    }
    return match
  }

  private async getKeys(jwksUrl: string, forceRefresh: boolean): Promise<Jwk[]> {
    const cached = this.cache.get(jwksUrl)
    if (
      !forceRefresh &&
      cached &&
      this.now() - cached.fetchedAtMs < this.cacheTtlMs
    ) {
      return cached.keys
    }
    const res = await this.fetchImpl(jwksUrl)
    if (!res.ok) {
      throw AppError.unauthorized("Could not fetch identity provider keys.")
    }
    const body = (await res.json()) as { keys?: Jwk[] }
    const keys = Array.isArray(body.keys) ? body.keys : []
    this.cache.set(jwksUrl, { keys, fetchedAtMs: this.now() })
    return keys
  }
}

/** Default fetch wrapper around the global fetch (Node 18+/22). */
const defaultFetch: FetchLike = async (url: string) => {
  const res = await fetch(url)
  return { ok: res.ok, json: () => res.json() }
}

/** Base64url-decode a JWT segment and JSON.parse it; null on any failure. */
function decodeJsonSegment<T>(segment: string): T | null {
  try {
    const json = Buffer.from(segment, "base64url").toString("utf8")
    return JSON.parse(json) as T
  } catch {
    return null
  }
}

/**
 * Whether a token's `nonce` claim matches the expected nonce. Accepts EITHER the raw expected value OR
 * its SHA-256 hex (Sign in with Apple hashes the client nonce into the claim). Constant-time on the
 * compared bytes. A missing claim never matches.
 */
function nonceMatches(claimNonce: string | undefined, expected: string): boolean {
  if (typeof claimNonce !== "string" || claimNonce.length === 0) return false
  const expectedHash = createHash("sha256").update(expected).digest("hex")
  return constantTimeEqual(claimNonce, expected) || constantTimeEqual(claimNonce, expectedHash)
}

/** Constant-time string compare (equal length required; a length mismatch is a definite non-match). */
function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

/** Verify an RS256 signature over `signingInput` using an RSA JWK via WebCrypto. */
async function verifyRs256(jwk: Jwk, signingInput: string, signatureB64: string): Promise<boolean> {
  if (jwk.kty !== "RSA" || !jwk.n || !jwk.e) return false
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  )
  const signature = Buffer.from(signatureB64, "base64url")
  const data = new TextEncoder().encode(signingInput)
  return crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, data)
}

/** Validate iss/aud/exp/nbf and project the trusted subset of claims. */
function validateClaims(
  claims: JwtClaims,
  params: VerifyParams,
  now: () => number,
): VerifiedIdToken {
  const nowSec = params.nowSeconds ?? Math.floor(now() / 1000)

  if (!claims.iss || !params.issuers.includes(claims.iss)) {
    throw AppError.unauthorized("Identity token issuer mismatch.")
  }
  const auds = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : []
  if (!auds.includes(params.audience)) {
    throw AppError.unauthorized("Identity token audience mismatch.")
  }
  if (typeof claims.exp !== "number" || claims.exp <= nowSec) {
    throw AppError.unauthorized("Identity token has expired.")
  }
  if (typeof claims.nbf === "number" && claims.nbf > nowSec) {
    throw AppError.unauthorized("Identity token is not yet valid.")
  }
  if (!claims.sub) {
    throw AppError.unauthorized("Identity token is missing a subject.")
  }
  // P2-3 nonce binding: when the caller issued a nonce, the token MUST carry a matching one (raw or its
  // SHA-256 hex, since Apple native stores the hash). A missing/mismatched nonce is a replay -> reject.
  if (params.expectedNonce !== undefined) {
    if (!nonceMatches(claims.nonce, params.expectedNonce)) {
      throw AppError.unauthorized("Identity token nonce mismatch.")
    }
  }

  return {
    sub: claims.sub,
    email: typeof claims.email === "string" ? claims.email : null,
    emailVerified:
      claims.email_verified === true || claims.email_verified === "true" ? true : false,
    name: typeof claims.name === "string" ? claims.name : null,
  }
}
