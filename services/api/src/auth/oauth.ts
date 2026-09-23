import { Apple, Google, generateCodeVerifier, generateState } from "arctic"
import { AppError } from "@civfix/shared"
import { containsSlur } from "../abuse/slur-filter.js"
import {
  EmailTakenError,
  type OAuthIdentityStore,
  type UserRecord,
  type UserStore,
} from "./stores.js"
import { RemoteJwksVerifier, type JwksVerifier, type VerifiedIdToken } from "./jwks.js"

export const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"]
export const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs"
export const APPLE_ISSUER = "https://appleid.apple.com"
export const APPLE_JWKS_URL = "https://appleid.apple.com/auth/keys"

export const PROVIDER_GOOGLE = "google"
export const PROVIDER_APPLE = "apple"

export interface OAuthConfig {
  google?: {
    clientId: string
    clientSecret: string
    redirectUri: string
    extraAudiences?: string[]
  }
  apple?: {
    clientId: string
    teamId: string
    keyId: string
    privateKey: string
    redirectUri: string
    webClientId?: string
    extraAudiences?: string[]
  }
}

export interface OAuthServiceOptions {
  config: OAuthConfig
  oauthStore: OAuthIdentityStore
  users: UserStore
  verifier?: JwksVerifier
}

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

  get googleEnabled(): boolean {
    return this.config.google !== undefined
  }

  get appleEnabled(): boolean {
    return this.config.apple !== undefined
  }

  get appleWebEnabled(): boolean {
    return this.config.apple?.webClientId !== undefined
  }

  createGoogleAuthUrl(): GoogleAuthRequest {
    const client = this.requireGoogle()
    const state = generateState()
    const codeVerifier = generateCodeVerifier()
    const url = client.createAuthorizationURL(state, codeVerifier, ["openid", "email", "profile"])
    return { url: url.toString(), state, codeVerifier }
  }

  async completeGoogleCallback(code: string, codeVerifier: string): Promise<UserRecord> {
    const client = this.requireGoogle()
    const tokens = await client.validateAuthorizationCode(code, codeVerifier)
    const idToken = tokens.idToken()
    const claims = await this.verifyGoogleIdToken(idToken)
    return this.upsertFromClaims(PROVIDER_GOOGLE, claims)
  }

  createAppleAuthUrl(): { url: string; state: string } {
    const client = this.requireAppleWeb()
    const state = generateState()
    const url = client.createAuthorizationURL(state, ["name", "email"])
    url.searchParams.set("response_mode", "form_post")
    return { url: url.toString(), state }
  }

  async completeAppleCallback(code: string, fullName?: string): Promise<UserRecord> {
    const client = this.requireAppleWeb()
    const tokens = await client.validateAuthorizationCode(code)
    const idToken = tokens.idToken()
    const claims = await this.verifyAppleWebIdToken(idToken)
    return this.upsertFromClaims(PROVIDER_APPLE, claims, fullName)
  }

  async verifyGoogleIdToken(idToken: string, expectedNonce?: string): Promise<VerifiedIdToken> {
    const google = this.requireGoogleConfig()
    return this.verifier.verify(idToken, {
      jwksUrl: GOOGLE_JWKS_URL,
      issuers: GOOGLE_ISSUERS,
      audiences: [google.clientId, ...(google.extraAudiences ?? [])],
      ...(expectedNonce !== undefined ? { expectedNonce } : {}),
    })
  }

  async verifyAppleIdToken(
    identityToken: string,
    expectedNonce?: string,
  ): Promise<VerifiedIdToken> {
    const apple = this.requireAppleConfig()
    return this.verifier.verify(identityToken, {
      jwksUrl: APPLE_JWKS_URL,
      issuers: [APPLE_ISSUER],
      audiences: [apple.clientId, ...(apple.extraAudiences ?? [])],
      ...(expectedNonce !== undefined ? { expectedNonce } : {}),
    })
  }

  async signInWithGoogleIdToken(idToken: string, expectedNonce?: string): Promise<UserRecord> {
    const claims = await this.verifyGoogleIdToken(idToken, expectedNonce)
    return this.upsertFromClaims(PROVIDER_GOOGLE, claims)
  }

  async signInWithAppleIdToken(
    identityToken: string,
    fullName: string | undefined,
    expectedNonce?: string,
  ): Promise<UserRecord> {
    const claims = await this.verifyAppleIdToken(identityToken, expectedNonce)
    return this.upsertFromClaims(PROVIDER_APPLE, claims, fullName)
  }

  /**
   * Unlink EVERY provider identity held by `userId` (account deletion). The identity rows are what let a
   * provider sign-in find an account, so leaving them behind means Google/Apple walks back into the
   * tombstoned account the moment the ban marker's TTL lapses.
   */
  async unlinkAllForUser(userId: string): Promise<void> {
    await this.oauthStore.deleteAllForUser(userId)
  }

  private async upsertFromClaims(
    provider: string,
    claims: VerifiedIdToken,
    fullName?: string,
  ): Promise<UserRecord> {
    const identity = await this.oauthStore.findByProvider(provider, claims.sub)
    if (identity) {
      const user = await this.users.findById(identity.userId)
      // A SOFT-DELETED account is never resurrected by a provider identity that outlived it: deletion
      // tombstones the row (kept for referential truth) but the account is gone, so the link is treated
      // as absent and a fresh account is created below — linkIdentity then repoints this identity at it.
      // The email path applies the same rule, and deleteAccount unlinks identities up front so this is
      // only the backstop for links written before that landed.
      if (user && user.deletedAt === null) return user
    }

    // An address the provider has not verified proves nothing about who owns it: it is never stored and
    // never matched, or a token naming someone else's email would sign in as them, and an OTP sign-in by
    // the real owner would later walk into an account the token holder planted.
    const verifiedEmail = claims.email !== null && claims.emailVerified ? claims.email : null
    if (verifiedEmail !== null) {
      const linked = await this.linkExistingByEmail(verifiedEmail, provider, claims.sub)
      if (linked) return linked
    }

    let created: UserRecord
    try {
      created = await this.users.create(verifiedEmail, {
        displayName: providerDisplayName(fullName, claims, provider),
        role: "citizen",
        emailVerified: verifiedEmail !== null,
        avatarUrl: safeAvatarUrl(claims.picture),
        onEmailConflict: "reject",
      })
    } catch (err) {
      if (!(err instanceof EmailTakenError) || verifiedEmail === null) throw err
      // A concurrent first sign-in for the same verified address won the insert; link to its account.
      const linked = await this.linkExistingByEmail(verifiedEmail, provider, claims.sub)
      if (!linked) throw err
      return linked
    }
    await this.oauthStore.linkIdentity(created.id, provider, claims.sub)
    return created
  }

  private async linkExistingByEmail(
    verifiedEmail: string,
    provider: string,
    providerUserId: string,
  ): Promise<UserRecord | null> {
    const byEmail = await this.users.findByEmail(verifiedEmail)
    if (!byEmail || byEmail.deletedAt !== null) return null
    await this.oauthStore.linkIdentity(byEmail.id, provider, providerUserId)
    return byEmail
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

  private async verifyAppleWebIdToken(idToken: string): Promise<VerifiedIdToken> {
    const apple = this.requireAppleWebConfig()
    return this.verifier.verify(idToken, {
      jwksUrl: APPLE_JWKS_URL,
      issuers: [APPLE_ISSUER],
      audiences: [apple.webClientId],
    })
  }
}

// The same cap the profile editor enforces on a display name. Provider names (Apple's client-sent
// fullName, Google's name claim) are user-controlled and reach every author DTO before the profile step,
// so they are held to that cap and the slur filter here rather than rejected: a too-long or filtered name
// must not fail the sign-in itself.
const MAX_PROVIDER_DISPLAY_NAME_LENGTH = 80

function providerDisplayName(
  fullName: string | undefined,
  claims: VerifiedIdToken,
  provider: string,
): string {
  const candidates = [fullName, claims.name, emailLocalPart(claims.email)]
  for (const candidate of candidates) {
    const name = sanitizeDisplayName(candidate)
    if (name !== null) return name
  }
  return provider === PROVIDER_APPLE ? "Apple user" : "Google user"
}

function sanitizeDisplayName(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null
  const collapsed = raw.replace(/\s+/g, " ").trim()
  const name = truncateCodePoints(collapsed, MAX_PROVIDER_DISPLAY_NAME_LENGTH).trimEnd()
  if (name === "" || containsSlur(name)) return null
  return name
}

function truncateCodePoints(value: string, maxLength: number): string {
  let out = ""
  for (const codePoint of value) {
    if (out.length + codePoint.length > maxLength) break
    out += codePoint
  }
  return out
}

function emailLocalPart(email: string | null): string | null {
  if (!email) return null
  const at = email.indexOf("@")
  return at > 0 ? email.slice(0, at) : null
}

function safeAvatarUrl(picture: string | null): string | null {
  if (!picture) return null
  try {
    return new URL(picture).protocol === "https:" ? picture : null
  } catch {
    return null
  }
}

function decodeApplePrivateKey(pem: string): Uint8Array {
  const b64 = pem
    .replace(/\\n/g, "\n")
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "")
  return new Uint8Array(Buffer.from(b64, "base64"))
}
