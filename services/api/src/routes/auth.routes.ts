
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
import { perHost } from "../plugins/rate-limit.js"
import type { Container } from "../di.js"
import type { AuthServices } from "../auth/auth-services.js"
import { toUserDTO } from "../auth/auth-services.js"
import { requireAuth } from "../auth/context.js"
import { SUSPENDED_MESSAGE } from "../auth/account-status.js"
import { makeWsTicketStore } from "../auth/ws-ticket.js"
import { sha256Hex } from "../auth/crypto.js"
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

export const OTP_REQUEST_RATE_LIMIT = perHost({ max: 5, timeWindow: "1 minute" })
export const OTP_VERIFY_RATE_LIMIT = perHost({ max: 10, timeWindow: "1 minute" })
export const OAUTH_RATE_LIMIT = perHost({ max: 20, timeWindow: "1 minute" })

export function guestSmsEnabledFor(env: Container["env"]): boolean {
  return env.SMS_GUEST_ENABLED && (env.USE_FAKE_SMS || env.TWILIO_SMS_FROM.length > 0)
}

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

async function redeemOAuthNonce(cache: CacheClient, presented: string): Promise<string | null> {
  const issued = await oauthNonces(cache).redeem(presented)
  return issued === null ? null : presented
}

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
  const guestSmsEnabled = guestSmsEnabledFor(container.env)
  const webOrigins = container.env.WEB_ORIGINS
  const csrf = container.csrf
  const csrfProtect = csrf.protect

  async function isReservedOrJurisdiction(handle: string): Promise<boolean> {
    if (isReservedHandle(handle)) return true
    if (!container.env.DATABASE_URL) return false
    return handleCollidesWithJurisdiction(container.getDb().sql, handle)
  }

  route(app, "otpRequest", { config: { rateLimit: OTP_REQUEST_RATE_LIMIT, allowSuspended: true } }, async (request, reply) => {
    const body = parse(EmailOtpRequestRequestSchema, request.body)
    const result = await services.otp.issueOtp(body.email, request.ip || null)
    const payload: EmailOtpRequestResponse = { sent: true, resendAfterSec: result.resendAfterSec }
    reply.status(200).send(payload)
  })

  route(app, "otpVerify", { config: { rateLimit: OTP_VERIFY_RATE_LIMIT } }, async (request, reply) => {
    const body = parse(EmailOtpVerifyRequestSchema, request.body)
    const userId = await services.otp.verifyOtp(body.email, body.code, request.ip || null)
    await issueSession(services, csrf, request, reply, userId, { guestSmsEnabled })
  })

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
    const expectedNonce = await requireIssuedNonce(services.cache, body.nonce, {
      required: container.env.OAUTH_REQUIRE_NONCE,
      log: request.log,
    })
    const user = await services.oauth.signInWithAppleIdToken(
      body.identityToken,
      body.fullName,
      expectedNonce,
    )
    await issueSessionForUser(services, csrf, request, reply, user, { guestSmsEnabled })
  })

  route(app, "googleSignIn", { config: { rateLimit: OAUTH_RATE_LIMIT } }, async (request, reply) => {
    const body = parse(GoogleSignInRequestSchema, request.body)
    const expectedNonce = await requireIssuedNonce(services.cache, body.nonce, {
      required: container.env.OAUTH_REQUIRE_NONCE,
      log: request.log,
    })
    const user = await services.oauth.signInWithGoogleIdToken(body.idToken, expectedNonce)
    await issueSessionForUser(services, csrf, request, reply, user, { guestSmsEnabled })
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
      guestSmsEnabled,
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
        guestSmsEnabled,
      })
    })
  })

  route(app, "session", async (request, reply) => {
    const payload = await buildSessionCheck(services, csrf, request, reply)
    reply.status(200).send({ ...payload, guestSmsEnabled: guestSmsEnabledFor(container.env) })
  })

  route(app, "logout", { preHandler: csrfProtect, config: { allowSuspended: true } }, async (request, reply) => {
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
    const token = presentedSessionToken(request)
    if (token === null) throw AppError.unauthorized()
    const payload = await makeWsTicketStore(services.cache).mint(userId, await sha256Hex(token))
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

    const current = await services.users.findById(userId)
    if (handleChanged(current?.handle ?? null, body.handle)) {
      assertNoSlur(body.handle, "handle")
      if (await isReservedOrJurisdiction(body.handle.trim())) {
        throw AppError.validation({ handle: "That username isn't available." })
      }
    }

    const avatarUrlDurable = (container.env.R2_PUBLIC_BASE ?? "").length > 0
    const updated = await services.users.updateProfile(userId, {
      handle: body.handle,
      displayName: body.displayName,
      ...(body.bio !== undefined ? { bio: body.bio } : {}),
      ...(body.socialLinks !== undefined ? { socialLinks: body.socialLinks } : {}),
      ...(body.avatarUploadId !== undefined
        ? {
            avatarUploadId: body.avatarUploadId,
            ...(avatarUrlDurable
              ? { presignAvatar: (k: string) => container.storage.presignGet(k, MEDIA_GET_URL_TTL_SEC) }
              : {}),
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
  guestSmsEnabled?: boolean
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
  const accountStatus = await services.users.accountStatus(user.id)
  if (accountStatus === "banned") {
    throw AppError.forbidden("This account has been banned.")
  }
  if (accountStatus === "suspended") {
    throw AppError.forbidden(SUSPENDED_MESSAGE)
  }
  const kind = opts.forceKind ?? clientKind(request)
  const token = await services.sessions.createSession(user.id, [user.role], {
    userAgent: request.headers["user-agent"] ?? null,
    ip: request.ip || null,
    accountStatus,
  })
  const dto: UserDTO = toUserDTO(user)
  const ttl = services.sessions.ttl

  const guestSms =
    opts.guestSmsEnabled !== undefined ? { guestSmsEnabled: opts.guestSmsEnabled } : {}

  if (kind === "mobile") {
    const payload: SessionResponse = { user: dto, token, ...guestSms }
    reply.status(200).send(payload)
    return
  }

  setSessionCookie(reply, token, ttl)
  const csrfToken = await csrf.tokenForSession(token)
  setCsrfCookie(reply, csrfToken, ttl)
  if (opts.webRedirectTo !== undefined) {
    reply.redirect(opts.webRedirectTo)
    return
  }
  const payload: SessionResponse = { user: dto, csrfToken, ...guestSms }
  reply.status(200).send(payload)
}

async function buildSessionCheck(
  services: AuthServices,
  csrf: Csrf,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<SessionCheckResponse> {
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

async function webCsrfToken(
  csrf: Csrf,
  request: FastifyRequest,
  reply: FastifyReply,
  services: AuthServices,
): Promise<string | null> {
  if (bearerToken(request) !== null) return null

  const sessionToken = sessionCookieValue(request)
  if (sessionToken === null) return null

  const expiresAtMs = request.sessionExpiresAtMs
  if (expiresAtMs !== undefined) {
    const remainingSeconds = Math.ceil((expiresAtMs - Date.now()) / 1000)
    if (remainingSeconds > 0) {
      setSessionCookie(reply, sessionToken, remainingSeconds)
    }
  }

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
