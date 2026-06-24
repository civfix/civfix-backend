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
    /**
     * Additional accepted ID-token audiences beyond `clientId` (the web client). Google's native mobile
     * sign-in can mint a token whose `aud` is the iOS or Android OAuth client id — separate clients from
     * the web one — so those ids are accepted here too (GOOGLE_OAUTH_IOS_CLIENT_ID /
     * GOOGLE_OAUTH_ANDROID_CLIENT_ID). The web `clientId` is always accepted implicitly.
     */
    extraAudiences?: string[]
  }
  apple?: {
    clientId: string
    teamId: string
    keyId: string
    /** PEM contents of the .p8 private key. */
    privateKey: string
    redirectUri: string
    /**
     * The Apple "Services ID" for Sign in with Apple on the WEB (separate from `clientId`, the native
     * bundle id). When set it enables the web redirect flow (createAppleAuthUrl / completeAppleCallback)
     * and is the audience the web id_token is verified against. Unset => web Apple sign-in is unavailable.
     */
    webClientId?: string
    /**
     * Additional accepted ID-token audiences for the NATIVE flow beyond `clientId`. A native iOS Sign in
     * with Apple identity token's `aud` is the app bundle id (org.civfix.community); when `clientId` is
     * configured to the WEB Services ID instead, the bundle id is accepted here so native sign-in still
     * verifies (mirrors Google's `extraAudiences`). `clientId` is always accepted implicitly.
     */
    extraAudiences?: string[]
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

  /** Whether the Apple flow is configured (covers the native/mobile token flow). */
  get appleEnabled(): boolean {
    return this.config.apple !== undefined
  }

  /** Whether the Apple WEB redirect flow is configured (needs the Services ID, APPLE_OAUTH_WEB_CLIENT_ID). */
  get appleWebEnabled(): boolean {
    return this.config.apple?.webClientId !== undefined
  }

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

  /**
   * Build an Apple WEB authorization URL plus the state the callback must echo. Apple has no PKCE (so no
   * code verifier, unlike Google). We request `name email` scopes to learn the user on first consent; Apple
   * REQUIRES `response_mode=form_post` whenever scopes are requested (Arctic builds the code-flow URL but
   * leaves the response mode unset, so we add it), which is why the callback is a POST.
   */
  createAppleAuthUrl(): { url: string; state: string } {
    const client = this.requireAppleWeb()
    const state = generateState()
    const url = client.createAuthorizationURL(state, ["name", "email"])
    url.searchParams.set("response_mode", "form_post")
    return { url: url.toString(), state }
  }

  /**
   * Complete the Apple WEB callback: exchange `code` for tokens (Arctic signs the client_secret JWT with
   * the .p8 key), verify the returned id_token (its `aud` is the Services ID, NOT the native bundle id),
   * and upsert the user. `fullName` is Apple's first-consent display name, parsed by the route from the
   * form_post `user` field (absent on later sign-ins). The caller validates state against the stash first.
   */
  async completeAppleCallback(code: string, fullName?: string): Promise<UserRecord> {
    const client = this.requireAppleWeb()
    const tokens = await client.validateAuthorizationCode(code)
    const idToken = tokens.idToken()
    const claims = await this.verifyAppleWebIdToken(idToken)
    return this.upsertFromClaims(PROVIDER_APPLE, claims, fullName)
  }

  /** Verify a Google ID token's signature + claims and return the verified subject/email. */
  async verifyGoogleIdToken(idToken: string): Promise<VerifiedIdToken> {
    const google = this.requireGoogleConfig()
    return this.verifier.verify(idToken, {
      jwksUrl: GOOGLE_JWKS_URL,
      issuers: GOOGLE_ISSUERS,
      // Web client id is always valid; configured iOS/Android native client ids are accepted too.
      audiences: [google.clientId, ...(google.extraAudiences ?? [])],
    })
  }

  /**
   * Verify an Apple ID token's signature + claims and return the verified subject/email. When
   * `expectedNonce` is supplied (the client issued one) it is bound: the token's nonce claim must match
   * it (raw or its SHA-256 hex), closing ID-token replay (P2-3).
   */
  async verifyAppleIdToken(
    identityToken: string,
    expectedNonce?: string,
  ): Promise<VerifiedIdToken> {
    const apple = this.requireAppleConfig()
    return this.verifier.verify(identityToken, {
      jwksUrl: APPLE_JWKS_URL,
      issuers: [APPLE_ISSUER],
      // Native bundle-id `aud` is always valid; a configured iOS bundle id (extraAudiences) is accepted too,
      // so native sign-in verifies even when clientId is the web Services ID.
      audiences: [apple.clientId, ...(apple.extraAudiences ?? [])],
      ...(expectedNonce !== undefined ? { expectedNonce } : {}),
    })
  }

  /** Mobile Google sign-in: verify the ID token and upsert the user. */
  async signInWithGoogleIdToken(idToken: string): Promise<UserRecord> {
    const claims = await this.verifyGoogleIdToken(idToken)
    return this.upsertFromClaims(PROVIDER_GOOGLE, claims)
  }

  /**
   * Apple sign-in (POST flow): verify the identity token and upsert the user. When the client sent a
   * `nonce`, it is bound during verification (P2-3) so a captured token cannot be replayed.
   */
  async signInWithAppleIdToken(
    identityToken: string,
    fullName: string | undefined,
    expectedNonce?: string,
  ): Promise<UserRecord> {
    const claims = await this.verifyAppleIdToken(identityToken, expectedNonce)
    return this.upsertFromClaims(PROVIDER_APPLE, claims, fullName)
  }

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

    // 2) Link to an existing account that owns this VERIFIED email. SECURITY (nOAuth / pre-account-
    //    takeover): only an email the provider asserted as verified may match-and-link an existing
    //    account. A provider that lets a user set an arbitrary UNVERIFIED email must not be able to take
    //    over an account created via email-OTP or another provider that owns that address. An unverified
    //    (or relay/absent) email falls through to branch 3 and gets a fresh, separate account instead.
    //    A tombstoned (soft-deleted) account is NOT relinked — resurrecting a deleted identity would
    //    silently undelete it; those sign-ins fall through to a fresh account.
    if (claims.email && claims.emailVerified) {
      const byEmail = await this.users.findByEmail(claims.email)
      if (byEmail && byEmail.deletedAt === null) {
        await this.oauthStore.linkIdentity(byEmail.id, provider, claims.sub)
        return byEmail
      }
    }

    // 3) Brand-new user + identity. Convergence under a concurrent first sign-in comes from create()'s
    //    ON CONFLICT (email) — both racers resolve to one user — and linkIdentity's idempotent UPSERT.
    //    Mark the email verified only when the provider asserted one; unverified/absent leaves it false.
    const created = await this.users.create(claims.email ?? null, {
      displayName: fullName ?? deriveDisplayName(claims, provider),
      role: "citizen",
      emailVerified: claims.email !== null && claims.emailVerified,
      // Capture the provider photo, but only an https: URL (it is rendered as <img src>); Apple never
      // sends one, so this stays null there.
      avatarUrl: safeAvatarUrl(claims.picture),
    })
    await this.oauthStore.linkIdentity(created.id, provider, claims.sub)
    return created
  }

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

  private requireAppleWebConfig(): NonNullable<OAuthConfig["apple"]> & { webClientId: string } {
    const apple = this.config.apple
    if (!apple?.webClientId) {
      throw AppError.validation(undefined, "Apple web sign-in is not configured.")
    }
    return { ...apple, webClientId: apple.webClientId }
  }

  private requireAppleWeb(): Apple {
    const cfg = this.requireAppleWebConfig()
    if (!this.appleClient) {
      // client_id is the Services ID (web); the team/key/.p8 are shared with the native config. Arctic
      // wants the PKCS#8 private key as raw DER bytes (it signs the client_secret JWT with them).
      this.appleClient = new Apple(
        cfg.webClientId,
        cfg.teamId,
        cfg.keyId,
        decodeApplePrivateKey(cfg.privateKey),
        cfg.redirectUri,
      )
    }
    return this.appleClient
  }

  /** Verify an Apple WEB id_token: same issuer/JWKS as the native flow, but its audience is the Services ID. */
  private async verifyAppleWebIdToken(idToken: string): Promise<VerifiedIdToken> {
    const apple = this.requireAppleWebConfig()
    return this.verifier.verify(idToken, {
      jwksUrl: APPLE_JWKS_URL,
      issuers: [APPLE_ISSUER],
      audiences: [apple.webClientId],
    })
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

/**
 * Accept a provider avatar URL only when it is an https: URL (it is persisted and rendered as
 * <img src>); anything else (http:, javascript:, data:, malformed) is dropped to null.
 */
function safeAvatarUrl(picture: string | null): string | null {
  if (!picture) return null
  try {
    return new URL(picture).protocol === "https:" ? picture : null
  } catch {
    return null
  }
}

/**
 * Decode an Apple .p8 Sign-in key (PEM-wrapped PKCS#8) into the raw DER bytes Arctic's `Apple` client wants
 * (it signs the OAuth client_secret JWT with them). Tolerant of how the key is stored in env: accepts real
 * or escaped (`\n`) newlines, with or without the BEGIN/END armor — everything outside the base64 body is
 * stripped before decoding.
 */
function decodeApplePrivateKey(pem: string): Uint8Array {
  const b64 = pem
    .replace(/\\n/g, "\n")
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "")
  return new Uint8Array(Buffer.from(b64, "base64"))
}
