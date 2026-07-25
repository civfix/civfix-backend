
import {
  AppleSignInRequestSchema,
  AppleCallbackBodySchema,
  GoogleSignInRequestSchema,
  EmailOtpRequestRequestSchema,
  EmailOtpVerifyRequestSchema,
  OAuthCallbackQuerySchema,
  OAuthStartQuerySchema,
  UpdateProfileRequestSchema,
  HandleAvailableRequestSchema,
  isValidHandle,
  AppError,
  type SessionResponse,
  type SessionCheckResponse,
  type LogoutResponse,
  type EmailOtpRequestResponse,
  type UpdateProfileResponse,
  type HandleAvailableResponse,
  type UserDTO,
} from "@civfix/shared"
import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify"
import type { Container } from "../di.js"
import type { AuthServices } from "../auth/auth-services.js"
import { toUserDTO } from "../auth/auth-services.js"
import { requireAuth } from "../auth/context.js"
import { makeWsTicketStore } from "../auth/ws-ticket.js"
import { assertNoSlur } from "../abuse/slur-filter.js"
import { isReservedHandle, handleCollidesWithJurisdiction } from "../auth/reserved-handles.js"
import { handleChanged } from "../auth/handle-policy.js"
import { isProd } from "../env.js"
import { route } from "../versioning/route.js"
import { parse } from "./_validate.js"
import { setCsrfCookie, clearCsrfCookie, type Csrf } from "../auth/csrf.js"
import {
  makeSingleUseSecretStore,
  type SingleUseSecretStore,
} from "../auth/single-use-secret.js"
import type { CacheClient } from "../auth/cache.js"
import { MEDIA_GET_URL_TTL_SEC } from "../services/media-intake-service.js"
import {
  clientKind,
  bearerToken,
  presentedSessionToken,
  setSessionCookie,
  clearSessionCookie,
  sessionCookieValue,
  type ClientKind,
} from "../auth/transport.js"
import type { UserRecord } from "../auth/stores.js"

const OAUTH_STATE_COOKIE = "civfix_oauth"
const OAUTH_STATE_TTL_SECONDS = 10 * 60

const OTP_REQUEST_RATE_LIMIT = { max: 5, timeWindow: "1 minute" } as const
const OTP_VERIFY_RATE_LIMIT = { max: 10, timeWindow: "1 minute" } as const
const OAUTH_RATE_LIMIT = { max: 20, timeWindow: "1 minute" } as const

/**
 * Server-issued sign-in nonces for the NATIVE Apple/Google flows (H1).
 *
 * Native sign-in hands us an ID token minted by Apple/Google for a client the app controls. The token
 * alone proves only that SOMEONE authenticated at some point — it is a bearer artifact that lives in
 * process memory, crash dumps and logs for its whole `exp` window, and it is replayable by anyone who
 * gets a copy. The nonce is what makes it a proof of a LIVE, THIS-REQUEST authentication: the client
 * asks us for a nonce, passes it into the platform sign-in sheet (which binds it into the token's
 * `nonce` claim), and returns it with the token.
 *
 * Previously the "expected" nonce was read from the same request body that carried the token, which is
 * a tautology — an attacker replaying a stolen token simply echoes the nonce it contains. So the nonce
 * must be (a) MINTED HERE, from the CSPRNG, and (b) SINGLE-USE. Both, plus store-it-hashed, are exactly
 * the guarantees auth/single-use-secret.ts provides (the same machine behind WS handshake tickets), so
 * the atomicity reasoning is not restated here — see that module.
 */
const OAUTH_NONCE_TTL_SECONDS = 10 * 60
const OAUTH_NONCE_PREFIX = "oauthnonce:"

function oauthNonces(cache: CacheClient): SingleUseSecretStore {
  return makeSingleUseSecretStore(cache, {
    prefix: OAUTH_NONCE_PREFIX,
    ttlSeconds: OAUTH_NONCE_TTL_SECONDS,
  })
}

async function mintOAuthNonce(cache: CacheClient): Promise<{ nonce: string; expiresInSeconds: number }> {
  const { secret, expiresInSeconds } = await oauthNonces(cache).mint()
  return { nonce: secret, expiresInSeconds }
}

/**
 * Atomically consume a presented nonce, returning the value the caller may use as the EXPECTED nonce, or
 * null when it was never issued, has expired, or has already been spent. The nonce carries no payload —
 * the presented value IS what the ID token's `nonce` claim must match.
 */
async function redeemOAuthNonce(cache: CacheClient, presented: string): Promise<string | null> {
  const issued = await oauthNonces(cache).redeem(presented)
  return issued === null ? null : presented
}

/**
 * Redeem the nonce carried by a native sign-in request, returning the value to compare against the ID
 * token's `nonce` claim — or undefined when there is nothing to compare and the transition gate allows it.
 *
 * TRANSITION (OAUTH_REQUIRE_NONCE, default OFF). The end state is a mandatory nonce; shipping that
 * immediately is a total outage. The shared contract still types `nonce` as optional, no shipped native
 * build sends one, and recovery would need an EAS build plus App Store review — days during which nobody
 * can sign in with Apple or Google. So this follows the same accept-both shape as WS_ALLOW_QUERY_TOKEN:
 *
 *   - a nonce that IS presented is ALWAYS redeemed against the server-issued store, single-use. An
 *     updated client therefore gets the full H1 protection the moment it ships, with no flag flip.
 *   - a nonce that is ABSENT is refused once the flag is on, and until then is allowed with a warning.
 *
 * What this never does is fall back to the original bug — comparing the token's nonce claim against a
 * value from the same request body, which proves nothing. Absent means "no nonce check", not "check the
 * attacker's own value".
 *
 * Flip OAUTH_REQUIRE_NONCE=true once the nonce-sending mobile build is the floor in the store.
 */
async function requireIssuedNonce(
  cache: CacheClient,
  presented: string | undefined,
  opts: { required: boolean; log: FastifyBaseLogger },
): Promise<string | undefined> {
  if (presented === undefined || presented.length === 0) {
    if (opts.required) {
      throw AppError.validation({ nonce: "required: request one from /v1/auth/oauth/nonce first" })
    }
    opts.log.warn(
      { control: "oauth-nonce" },
      "native sign-in accepted with no nonce (OAUTH_REQUIRE_NONCE is off) — ID-token replay is not bounded for this client",
    )
    return undefined
  }
  const redeemed = await redeemOAuthNonce(cache, presented)
  if (redeemed === null) {
    throw AppError.unauthorized("Sign-in nonce is unknown, expired, or already used.")
  }
  return redeemed
}

export async function registerAuthRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  const services = app.authServices
  const webOrigins = container.env.WEB_ORIGINS
  // ONE csrf instance for both halves: the tokens minted below are verified by this same preHandler, so
  // they must be signed with the key this container was built from (see auth/csrf.ts).
  const csrf = container.csrf
  const csrfProtect = csrf.protect

  async function isReservedOrJurisdiction(handle: string): Promise<boolean> {
    if (isReservedHandle(handle)) return true
    if (!container.env.DATABASE_URL) return false
    return handleCollidesWithJurisdiction(container.getDb().sql, handle)
  }

  route(app, "otpRequest", { config: { rateLimit: OTP_REQUEST_RATE_LIMIT } }, async (request, reply) => {
    const body = parse(EmailOtpRequestRequestSchema, request.body)
    const result = await services.otp.issueOtp(body.email, request.ip || null)
    const payload: EmailOtpRequestResponse = { sent: true, resendAfterSec: result.resendAfterSec }
    reply.status(200).send(payload)
  })

  route(app, "otpVerify", { config: { rateLimit: OTP_VERIFY_RATE_LIMIT } }, async (request, reply) => {
    const body = parse(EmailOtpVerifyRequestSchema, request.body)
    const userId = await services.otp.verifyOtp(body.email, body.code, request.ip || null)
    await issueSession(services, csrf, request, reply, userId)
  })

  // Mint a server-issued, single-use sign-in nonce (H1). Registered as a raw route rather than through
  // the shared endpoint registry because the contract package is versioned separately; the path mirrors
  // the versioned /v1/auth/* surface so the typed client can adopt it without moving.
  app.post(
    "/v1/auth/oauth/nonce",
    { config: { rateLimit: OAUTH_RATE_LIMIT } },
    async (_request, reply) => {
      const payload = await mintOAuthNonce(services.cache)
      reply.status(200).send(payload)
    },
  )

  route(app, "appleSignIn", { config: { rateLimit: OAUTH_RATE_LIMIT } }, async (request, reply) => {
    const body = parse(AppleSignInRequestSchema, request.body)
    // Redeem BEFORE verifying the token: the nonce is what makes this a live sign-in rather than a
    // replay, and it must be spent exactly once whatever the token turns out to be.
    const expectedNonce = await requireIssuedNonce(services.cache, body.nonce, {
      required: container.env.OAUTH_REQUIRE_NONCE,
      log: request.log,
    })
    const user = await services.oauth.signInWithAppleIdToken(
      body.identityToken,
      body.fullName,
      expectedNonce,
    )
    await issueSessionForUser(services, csrf, request, reply, user)
  })

  route(app, "googleSignIn", { config: { rateLimit: OAUTH_RATE_LIMIT } }, async (request, reply) => {
    const body = parse(GoogleSignInRequestSchema, request.body)
    const expectedNonce = await requireIssuedNonce(services.cache, body.nonce, {
      required: container.env.OAUTH_REQUIRE_NONCE,
      log: request.log,
    })
    const user = await services.oauth.signInWithGoogleIdToken(body.idToken, expectedNonce)
    await issueSessionForUser(services, csrf, request, reply, user)
  })

  route(app, "googleStart", { config: { rateLimit: OAUTH_RATE_LIMIT } }, async (request, reply) => {
    const startQuery = parse(OAuthStartQuerySchema, request.query)
    if (startQuery.redirect !== undefined && !isAllowedPostLoginRedirect(startQuery.redirect, webOrigins)) {
      throw AppError.validation({ redirect: "must be an allowed origin or a relative path" })
    }
    const auth = services.oauth.createGoogleAuthUrl()
    const stash: OAuthStash = {
      state: auth.state,
      codeVerifier: auth.codeVerifier,
      ...(startQuery.redirect !== undefined ? { redirect: startQuery.redirect } : {}),
    }
    reply.setCookie(OAUTH_STATE_COOKIE, JSON.stringify(stash), {
      signed: true,
      httpOnly: true,
      sameSite: "lax",
      secure: isProd(),
      path: "/",
      maxAge: OAUTH_STATE_TTL_SECONDS,
    })
    reply.redirect(auth.url)
  })

  route(app, "googleCallback", { config: { rateLimit: OAUTH_RATE_LIMIT } }, async (request, reply) => {
    const query = parse(OAuthCallbackQuerySchema, request.query)
    const stash = readOAuthStash(request)
    if (!stash || stash.state !== query.state || stash.codeVerifier === undefined) {
      throw AppError.unauthorized("Invalid OAuth state.")
    }
    reply.clearCookie(OAUTH_STATE_COOKIE, { path: "/" })
    const user = await services.oauth.completeGoogleCallback(query.code, stash.codeVerifier)
    const target = resolvePostLoginRedirect(stash.redirect, webOrigins)
    await issueSessionForUser(services, csrf, request, reply, user, {
      forceKind: "web",
      webRedirectTo: target,
    })
  })

  route(app, "appleStart", { config: { rateLimit: OAUTH_RATE_LIMIT } }, async (request, reply) => {
    const startQuery = parse(OAuthStartQuerySchema, request.query)
    if (startQuery.redirect !== undefined && !isAllowedPostLoginRedirect(startQuery.redirect, webOrigins)) {
      throw AppError.validation({ redirect: "must be an allowed origin or a relative path" })
    }
    const auth = services.oauth.createAppleAuthUrl()
    const stash: OAuthStash = {
      state: auth.state,
      ...(startQuery.redirect !== undefined ? { redirect: startQuery.redirect } : {}),
    }
    // SameSite=None is REQUIRED for this one: Apple returns via a CROSS-SITE POST
    // (response_mode=form_post), which a Lax cookie is not sent on. None in turn requires Secure, i.e.
    // https — always true in production. Outside production the browser DROPS a None+Secure cookie over
    // plain http and every callback then fails "Invalid OAuth state", so dev degrades to Lax; Apple cannot
    // post to a localhost callback anyway, so the web flow is only exercisable against an https deployment.
    const httpsCrossSite = isProd()
    reply.setCookie(OAUTH_STATE_COOKIE, JSON.stringify(stash), {
      signed: true,
      httpOnly: true,
      sameSite: httpsCrossSite ? "none" : "lax",
      secure: httpsCrossSite,
      path: "/",
      maxAge: OAUTH_STATE_TTL_SECONDS,
    })
    reply.redirect(auth.url)
  })

  await app.register(async (appleScope) => {
    appleScope.addContentTypeParser(
      "application/x-www-form-urlencoded",
      { parseAs: "string" },
      (_req, body, done) => {
        try {
          done(null, Object.fromEntries(new URLSearchParams(body as string)))
        } catch (err) {
          done(err as Error)
        }
      },
    )
    route(appleScope, "appleCallback", { config: { rateLimit: OAUTH_RATE_LIMIT } }, async (request, reply) => {
      const body = parse(AppleCallbackBodySchema, request.body)
      const stash = readOAuthStash(request)
      if (!stash || stash.state !== body.state) {
        throw AppError.unauthorized("Invalid OAuth state.")
      }
      reply.clearCookie(OAUTH_STATE_COOKIE, { path: "/" })
      const fullName = appleFullNameFromUserField(body.user)
      const user = await services.oauth.completeAppleCallback(body.code, fullName)
      const target = resolvePostLoginRedirect(stash.redirect, webOrigins)
      await issueSessionForUser(services, csrf, request, reply, user, {
        forceKind: "web",
        webRedirectTo: target,
      })
    })
  })

  route(app, "session", async (request, reply) => {
    const payload = await buildSessionCheck(services, csrf, request, reply)
    reply.status(200).send(payload)
  })

  route(app, "logout", { preHandler: csrfProtect }, async (request, reply) => {
    // Logout is keyed on the PRESENTED credential, not on a resolved session. An expired / revoked /
    // banned session still leaves httpOnly cookies the SPA cannot clear itself, and requireAuth would 401
    // and leave them behind forever; those requests are logged out best-effort instead. A request carrying
    // NO credential has nothing to revoke or clear and stays 401, which is what the contract's
    // auth:"required" pins. CSRF is unaffected: a cross-site POST bearing the victim's cookies presents a
    // session cookie, so csrfProtect enforced the session-bound token before this handler ran.
    const token = presentedSessionToken(request)
    if (token === null) {
      throw AppError.unauthorized()
    }
    await services.sessions.revokeSession(token)
    clearSessionCookie(reply)
    clearCsrfCookie(reply)
    const payload: LogoutResponse = { ok: true }
    reply.status(200).send(payload)
  })

  route(app, "wsTicket", { preHandler: csrfProtect }, async (request, reply) => {
    const userId = requireAuth(request)
    const payload = await makeWsTicketStore(services.cache).mint(userId)
    reply.status(200).send(payload)
  })

  route(app, "checkHandle", async (request, reply) => {
    const userId = requireAuth(request)
    const { handle } = parse(HandleAvailableRequestSchema, request.query)
    if (!isValidHandle(handle)) {
      const payload: HandleAvailableResponse = { available: false, reason: "invalid" }
      reply.status(200).send(payload)
      return
    }
    const existing = await services.users.findByHandle(handle.trim())
    if (existing !== null && existing.id === userId) {
      const payload: HandleAvailableResponse = { available: true, reason: null }
      reply.status(200).send(payload)
      return
    }
    if (await isReservedOrJurisdiction(handle.trim())) {
      const payload: HandleAvailableResponse = { available: false, reason: "reserved" }
      reply.status(200).send(payload)
      return
    }
    const payload: HandleAvailableResponse =
      existing === null
        ? { available: true, reason: null }
        : { available: false, reason: "taken" }
    reply.status(200).send(payload)
  })

  route(app, "updateProfile", { preHandler: csrfProtect }, async (request, reply) => {
    const userId = requireAuth(request)
    const body = parse(UpdateProfileRequestSchema, request.body)
    assertNoSlur(body.displayName, "displayName")
    assertNoSlur(body.bio ?? null, "bio")

    // Responsibility split (see auth/handle-policy.ts): the ROUTE owns the slur / reserved / jurisdiction
    // gate, the STORE owns format + uniqueness + the rename cooldown. The change predicate comes from the
    // policy module rather than a second inline copy, and uniqueness is NOT pre-checked here — the store
    // resolves it (plus a unique-violation catch) on the same request, so a duplicate query per rename
    // bought nothing but a way for the two answers to drift.
    const current = await services.users.findById(userId)
    if (handleChanged(current?.handle ?? null, body.handle)) {
      assertNoSlur(body.handle, "handle")
      if (await isReservedOrJurisdiction(body.handle.trim())) {
        throw AppError.validation({ handle: "That username isn't available." })
      }
    }

    const updated = await services.users.updateProfile(userId, {
      handle: body.handle,
      displayName: body.displayName,
      ...(body.bio !== undefined ? { bio: body.bio } : {}),
      ...(body.socialLinks !== undefined ? { socialLinks: body.socialLinks } : {}),
      ...(body.avatarUploadId !== undefined
        ? {
            avatarUploadId: body.avatarUploadId,
            presignAvatar: (k: string) => container.storage.presignGet(k, MEDIA_GET_URL_TTL_SEC),
          }
        : {}),
    })
    const payload: UpdateProfileResponse = { user: toUserDTO(updated) }
    reply.status(200).send(payload)
  })
}

interface IssueSessionOptions {
  forceKind?: ClientKind
  webRedirectTo?: string
}

async function issueSession(
  services: AuthServices,
  csrf: Csrf,
  request: FastifyRequest,
  reply: FastifyReply,
  userId: string,
  opts: IssueSessionOptions = {},
): Promise<void> {
  const user = await services.users.findById(userId)
  if (!user) {
    throw AppError.internal("User vanished after sign-in.")
  }
  await issueSessionForUser(services, csrf, request, reply, user, opts)
}

async function issueSessionForUser(
  services: AuthServices,
  csrf: Csrf,
  request: FastifyRequest,
  reply: FastifyReply,
  user: UserRecord,
  opts: IssueSessionOptions = {},
): Promise<void> {
  const kind = opts.forceKind ?? clientKind(request)
  const token = await services.sessions.createSession(user.id, [user.role], {
    userAgent: request.headers["user-agent"] ?? null,
    ip: request.ip || null,
  })
  const dto: UserDTO = toUserDTO(user)
  const ttl = services.sessions.ttl

  if (kind === "mobile") {
    const payload: SessionResponse = { user: dto, token }
    reply.status(200).send(payload)
    return
  }

  setSessionCookie(reply, token, ttl)
  // The CSRF token is DERIVED from the session just minted (see auth/csrf.ts), so it is only valid for
  // this session and cannot be planted by anything that merely writes cookies for the site.
  const csrfToken = await csrf.tokenForSession(token)
  setCsrfCookie(reply, csrfToken, ttl)
  if (opts.webRedirectTo !== undefined) {
    reply.redirect(opts.webRedirectTo)
    return
  }
  const payload: SessionResponse = { user: dto, csrfToken }
  reply.status(200).send(payload)
}

async function buildSessionCheck(
  services: AuthServices,
  csrf: Csrf,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<SessionCheckResponse> {
  // Always present: enabledProvidersFromConfig always includes "email", so the list cannot be empty even
  // after the apple filter, and the old `length > 0 ? … : {}` implied an optionality no client ever saw.
  const providerList =
    clientKind(request) === "web" && !services.oauth.appleWebEnabled
      ? services.enabledProviders.filter((p) => p !== "apple")
      : services.enabledProviders
  const enabledProviders = { enabledProviders: providerList }

  const { auth } = request
  if (!auth.userId) {
    return { authenticated: false, roles: [], ...enabledProviders }
  }
  const user = await services.users.findById(auth.userId)
  if (!user) {
    return { authenticated: false, roles: [], ...enabledProviders }
  }

  const csrfToken = await webCsrfToken(csrf, request, reply, services)

  return {
    authenticated: true,
    user: toUserDTO(user),
    roles: auth.roles,
    ...enabledProviders,
    ...(csrfToken !== null ? { csrfToken } : {}),
  }
}

/**
 * The CSRF token a cookie-transport client should use, refreshed on every session check.
 *
 * It is always RE-DERIVED from the presented session rather than echoed back from the cookie: an
 * existing cookie may be a pre-binding random value (or one planted by an attacker), and returning it
 * would keep that value alive forever. Re-deriving means the first session check after a client picks
 * up this build hands it the correct, session-bound token and overwrites the cookie with it.
 */
async function webCsrfToken(
  csrf: Csrf,
  request: FastifyRequest,
  reply: FastifyReply,
  services: AuthServices,
): Promise<string | null> {
  if (bearerToken(request) !== null) return null

  const sessionToken = sessionCookieValue(request)
  if (sessionToken === null) return null

  const token = await csrf.tokenForSession(sessionToken)
  setCsrfCookie(reply, token, services.sessions.ttl)
  return token
}

interface OAuthStash {
  state: string
  codeVerifier?: string
  redirect?: string
}

function readOAuthStash(request: FastifyRequest): OAuthStash | null {
  const raw = request.cookies[OAUTH_STATE_COOKIE]
  if (!raw) return null
  const unsigned = request.unsignCookie(raw)
  if (!unsigned.valid || unsigned.value === null) return null
  try {
    const parsed = JSON.parse(unsigned.value) as Partial<OAuthStash>
    if (typeof parsed.state === "string") {
      return {
        state: parsed.state,
        ...(typeof parsed.codeVerifier === "string" ? { codeVerifier: parsed.codeVerifier } : {}),
        ...(typeof parsed.redirect === "string" ? { redirect: parsed.redirect } : {}),
      }
    }
    return null
  } catch {
    return null
  }
}

function appleFullNameFromUserField(user: string | undefined): string | undefined {
  if (!user) return undefined
  try {
    const parsed = JSON.parse(user) as { name?: { firstName?: string; lastName?: string } }
    const full = `${parsed.name?.firstName?.trim() ?? ""} ${parsed.name?.lastName?.trim() ?? ""}`.trim()
    return full.length > 0 ? full : undefined
  } catch {
    return undefined
  }
}

export function resolvePostLoginRedirect(
  redirect: string | undefined,
  webOrigins: readonly string[],
): string {
  if (redirect !== undefined && isAllowedPostLoginRedirect(redirect, webOrigins)) {
    return redirect
  }
  return webOrigins[0] ?? "/"
}

const MAX_POST_LOGIN_REDIRECT_LENGTH = 2048

function isAllowedPostLoginRedirect(redirect: string, webOrigins: readonly string[]): boolean {
  if (redirect.length > MAX_POST_LOGIN_REDIRECT_LENGTH) return false
  const value = redirect.trim()
  if (value === "") return false
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return false
  if (value.startsWith("/")) {
    const base = webOrigins[0]
    if (base === undefined) return !value.startsWith("//") && !value.startsWith("/\\")
    let resolved: URL
    try {
      resolved = new URL(value, base)
    } catch {
      return false
    }
    return resolved.origin === new URL(base).origin
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false
  return webOrigins.includes(url.origin)
}
