/**
 * Apple + Google sign-in (plan section 8). Arctic and all JWT/JWKS verification are confined to this
 * adapter; the rest of the app sees only OAuthService + the OAuthIdentityStore seam.
 *
 * Flows:
 *   Google web   : createGoogleAuthUrl() -> Arctic createAuthorizationURL (PKCE + state). The route
 *                  stashes {state, codeVerifier} in a short-lived signed cookie and, on callback,
 *                  calls completeGoogleCallback() which exchanges the code and verifies the id_token.
 *   Google mobile: verifyGoogleIdToken(idToken) verifies a Google-issued ID token (aud == our client
 *                  id, iss == accounts.google.com, exp) and returns {sub, email}.
 *   Apple mobile : verifyAppleIdToken(identityToken) verifies an Apple-issued ID token the same way.
 *
 * Token verification needs the provider JWKS (network). That is behind the injectable `JwksVerifier`
 * seam: production uses RemoteJwksVerifier (fetch + WebCrypto), tests pass a stub so the OAuth logic
 * (claim checks, upsert, account linking) runs offline. createAuthorizationURL/validateAuthorization-
 * Code on the Arctic clients are likewise only constructed when real OAuth credentials are present.
 */

import { Apple, Google, generateCodeVerifier, generateState } from "arctic"
import { AppError } from "@civfix/shared"
import type { OAuthIdentityStore, UserRecord, UserStore } from "./stores.js"
import { RemoteJwksVerifier, type JwksVerifier, type VerifiedIdToken } from "./jwks.js"

export const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"]
export const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs"
export const APPLE_ISSUER = "https://appleid.apple.com"
export const APPLE_JWKS_URL = "https://appleid.apple.com/auth/keys"

export const PROVIDER_GOOGLE = "google"
export const PROVIDER_APPLE = "apple"

/** Per-provider OAuth credentials, all optional (a provider is simply unavailable when unset). */
export interface OAuthConfig {
  google?: {
    clientId: string
    clientSecret: string
    redirectUri: string
  }
  apple?: {
    clientId: string
    teamId: string
    keyId: string
    /** PEM contents of the .p8 private key. */
    privateKey: string
    redirectUri: string
  }
}

export interface OAuthServiceOptions {
  config: OAuthConfig
  oauthStore: OAuthIdentityStore
  users: UserStore
  /** Injectable JWKS verifier (tests pass a stub). Defaults to the real fetch+WebCrypto verifier. */
  verifier?: JwksVerifier
}

/** What the Google web flow needs to stash between /start and /callback. */
export interface GoogleAuthRequest {
  url: string
  state: string
  codeVerifier: string
}

export class OAuthService {
  private readonly config: OAuthConfig
  private readonly oauthStore: OAuthIdentityStore
  private readonly users: UserStore
  private readonly verifier: JwksVerifier
  private googleClient: Google | undefined
  private appleClient: Apple | undefined

  constructor(opts: OAuthServiceOptions) {
    this.config = opts.config
    this.oauthStore = opts.oauthStore
    this.users = opts.users
    this.verifier = opts.verifier ?? new RemoteJwksVerifier()
  }

  /** Whether the Google web/mobile flow is configured. */
  get googleEnabled(): boolean {
    return this.config.google !== undefined
  }

  /** Whether the Apple flow is configured. */
  get appleEnabled(): boolean {
    return this.config.apple !== undefined
  }

  // -------------------------------------------------------------------------
  // Google web (authorization-code + PKCE)
  // -------------------------------------------------------------------------

  /** Build a Google authorization URL plus the state/verifier the callback must echo. */
  createGoogleAuthUrl(): GoogleAuthRequest {
    const client = this.requireGoogle()
    const state = generateState()
    const codeVerifier = generateCodeVerifier()
    const url = client.createAuthorizationURL(state, codeVerifier, ["openid", "email", "profile"])
    return { url: url.toString(), state, codeVerifier }
  }

  /**
   * Complete the Google web callback: exchange `code` (with the stored PKCE verifier), pull the
   * id_token from the token response, verify it, and upsert the user. The caller is responsible for
   * having already checked the returned state against the stored state.
   */
  async completeGoogleCallback(code: string, codeVerifier: string): Promise<UserRecord> {
    const client = this.requireGoogle()
    const tokens = await client.validateAuthorizationCode(code, codeVerifier)
    const idToken = tokens.idToken()
    const claims = await this.verifyGoogleIdToken(idToken)
    return this.upsertFromClaims(PROVIDER_GOOGLE, claims)
  }

  // -------------------------------------------------------------------------
  // Mobile / native: verify an ID token directly
  // -------------------------------------------------------------------------

  /** Verify a Google ID token's signature + claims and return the verified subject/email. */
  async verifyGoogleIdToken(idToken: string): Promise<VerifiedIdToken> {
    const google = this.requireGoogleConfig()
    return this.verifier.verify(idToken, {
      jwksUrl: GOOGLE_JWKS_URL,
      issuers: GOOGLE_ISSUERS,
      audience: google.clientId,
    })
  }

  /** Verify an Apple ID token's signature + claims and return the verified subject/email. */
  async verifyAppleIdToken(identityToken: string): Promise<VerifiedIdToken> {
    const apple = this.requireAppleConfig()
    return this.verifier.verify(identityToken, {
      jwksUrl: APPLE_JWKS_URL,
      issuers: [APPLE_ISSUER],
      audience: apple.clientId,
    })
  }

  /** Mobile Google sign-in: verify the ID token and upsert the user. */
  async signInWithGoogleIdToken(idToken: string): Promise<UserRecord> {
    const claims = await this.verifyGoogleIdToken(idToken)
    return this.upsertFromClaims(PROVIDER_GOOGLE, claims)
  }

  /** Apple sign-in (POST flow): verify the identity token and upsert the user. */
  async signInWithAppleIdToken(
    identityToken: string,
    fullName: string | undefined,
  ): Promise<UserRecord> {
    const claims = await this.verifyAppleIdToken(identityToken)
    return this.upsertFromClaims(PROVIDER_APPLE, claims, fullName)
  }

  // -------------------------------------------------------------------------
  // Upsert / account linking
  // -------------------------------------------------------------------------

  /**
   * Find-or-create the user behind a verified identity:
   *   1. exact (provider, sub) identity hit -> return that user;
   *   2. else, if the verified email matches an existing user, LINK the identity to it;
   *   3. else create a fresh user, then link the identity.
   */
  private async upsertFromClaims(
    provider: string,
    claims: VerifiedIdToken,
    fullName?: string,
  ): Promise<UserRecord> {
    // 1) Known identity -> its user.
    const identity = await this.oauthStore.findByProvider(provider, claims.sub)
    if (identity) {
      const user = await this.users.findById(identity.userId)
      if (user) return user
      // Dangling identity (user removed): fall through and recreate.
    }

    // 2) Link to an existing account that owns this verified email.
    if (claims.email) {
      const byEmail = await this.users.findByEmail(claims.email)
      if (byEmail) {
        await this.oauthStore.linkIdentity(byEmail.id, provider, claims.sub)
        return byEmail
      }
    }

    // 3) Brand-new user + identity. Mark the email verified only when the provider asserted a
    // verified email; an unverified or absent email leaves email_verified false.
    const created = await this.users.create(claims.email ?? null, {
      displayName: fullName ?? deriveDisplayName(claims, provider),
      role: "citizen",
      emailVerified: claims.email !== null && claims.emailVerified,
    })
    await this.oauthStore.linkIdentity(created.id, provider, claims.sub)
    return created
  }

  // -------------------------------------------------------------------------
  // Lazy client / config accessors
  // -------------------------------------------------------------------------

  private requireGoogle(): Google {
    const cfg = this.requireGoogleConfig()
    if (!this.googleClient) {
      this.googleClient = new Google(cfg.clientId, cfg.clientSecret, cfg.redirectUri)
    }
    return this.googleClient
  }

  private requireGoogleConfig(): NonNullable<OAuthConfig["google"]> {
    if (!this.config.google) {
      throw AppError.validation(undefined, "Google sign-in is not configured.")
    }
    return this.config.google
  }

  private requireAppleConfig(): NonNullable<OAuthConfig["apple"]> {
    if (!this.config.apple) {
      throw AppError.validation(undefined, "Apple sign-in is not configured.")
    }
    return this.config.apple
  }

  /**
   * Build the Apple Arctic client (web OAuth). Apple needs the PKCS8 private key as bytes; the PEM
   * body is base64-decoded here. Exposed for the optional web Apple flow; the POST flow above does
   * not need it. Kept so wiring is honest when the web Apple flow is enabled.
   */
  private requireApple(): Apple {
    const cfg = this.requireAppleConfig()
    if (!this.appleClient) {
      const pkcs8 = pemToPkcs8Bytes(cfg.privateKey)
      this.appleClient = new Apple(cfg.clientId, cfg.teamId, cfg.keyId, pkcs8, cfg.redirectUri)
    }
    return this.appleClient
  }

  /** Reserved for the optional web Apple flow; references requireApple so it is not dead wiring. */
  createAppleAuthUrl(): { url: string; state: string } {
    const client = this.requireApple()
    const state = generateState()
    const url = client.createAuthorizationURL(state, ["name", "email"])
    return { url: url.toString(), state }
  }
}

/** Best-effort display name from verified claims; falls back to a provider-tagged default. */
function deriveDisplayName(claims: VerifiedIdToken, provider: string): string {
  if (claims.name && claims.name.trim().length > 0) return claims.name.trim()
  if (claims.email) {
    const at = claims.email.indexOf("@")
    if (at > 0) return claims.email.slice(0, at)
  }
  return provider === PROVIDER_APPLE ? "Apple user" : "Google user"
}

/** Decode a PEM private key body to raw PKCS8 bytes (strips header/footer + whitespace). */
function pemToPkcs8Bytes(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "")
  return Uint8Array.from(Buffer.from(body, "base64"))
}
