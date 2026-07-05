
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
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import type { Container } from "../di.js"
import type { AuthServices } from "../auth/auth-services.js"
import { toUserDTO } from "../auth/auth-services.js"
import { requireAuth } from "../auth/context.js"
import { assertNoSlur } from "../abuse/slur-filter.js"
import { isReservedHandle, handleCollidesWithJurisdiction } from "../auth/reserved-handles.js"
import { isProd } from "../env.js"
import { route } from "../versioning/route.js"
import { parse } from "./_validate.js"
import { csrfProtect, generateCsrfToken, setCsrfCookie, clearCsrfCookie } from "../auth/csrf.js"
import { MEDIA_GET_URL_TTL_SEC } from "../services/media-intake-service.js"
import {
  clientKind,
  bearerToken,
  presentedSessionToken,
  setSessionCookie,
  clearSessionCookie,
  CSRF_COOKIE,
  type ClientKind,
} from "../auth/transport.js"
import type { UserRecord } from "../auth/stores.js"

const OAUTH_STATE_COOKIE = "civfix_oauth"
const OAUTH_STATE_TTL_SECONDS = 10 * 60

const OTP_REQUEST_RATE_LIMIT = { max: 5, timeWindow: "1 minute" } as const
const OTP_VERIFY_RATE_LIMIT = { max: 10, timeWindow: "1 minute" } as const
const OAUTH_RATE_LIMIT = { max: 20, timeWindow: "1 minute" } as const

export async function registerAuthRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  const services = app.authServices
  const webOrigins = container.env.WEB_ORIGINS

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
    await issueSession(services, request, reply, userId)
  })

  route(app, "appleSignIn", async (request, reply) => {
    const body = parse(AppleSignInRequestSchema, request.body)
    const user = await services.oauth.signInWithAppleIdToken(
      body.identityToken,
      body.fullName,
      body.nonce,
    )
    await issueSessionForUser(services, request, reply, user)
  })

  route(app, "googleSignIn", async (request, reply) => {
    const body = parse(GoogleSignInRequestSchema, request.body)
    const user = await services.oauth.signInWithGoogleIdToken(body.idToken)
    await issueSessionForUser(services, request, reply, user)
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
    await issueSessionForUser(services, request, reply, user, {
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
    reply.setCookie(OAUTH_STATE_COOKIE, JSON.stringify(stash), {
      signed: true,
      httpOnly: true,
      sameSite: "none",
      secure: true,
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
      await issueSessionForUser(services, request, reply, user, {
        forceKind: "web",
        webRedirectTo: target,
      })
    })
  })

  route(app, "session", async (request, reply) => {
    const payload = await buildSessionCheck(services, request, reply)
    reply.status(200).send(payload)
  })

  route(app, "logout", { preHandler: csrfProtect }, async (request, reply) => {
    requireAuth(request)
    const token = presentedSessionToken(request)
    if (token) {
      await services.sessions.revokeSession(token)
    }
    clearSessionCookie(reply)
    clearCsrfCookie(reply)
    const payload: LogoutResponse = { ok: true }
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
    const handleChanged =
      current === null || (current.handle ?? "").toLowerCase() !== body.handle.toLowerCase()
    if (handleChanged) {
      assertNoSlur(body.handle, "handle")
      if (await isReservedOrJurisdiction(body.handle.trim())) {
        throw AppError.validation({ handle: "That username isn't available." })
      }
      const existing = await services.users.findByHandle(body.handle)
      if (existing !== null && existing.id !== userId) {
        throw AppError.conflict("That username is taken.")
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
  request: FastifyRequest,
  reply: FastifyReply,
  userId: string,
  opts: IssueSessionOptions = {},
): Promise<void> {
  const user = await services.users.findById(userId)
  if (!user) {
    throw AppError.internal("User vanished after sign-in.")
  }
  await issueSessionForUser(services, request, reply, user, opts)
}

async function issueSessionForUser(
  services: AuthServices,
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
  const csrfToken = generateCsrfToken()
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
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<SessionCheckResponse> {
  const providerList =
    clientKind(request) === "web" && !services.oauth.appleWebEnabled
      ? services.enabledProviders.filter((p) => p !== "apple")
      : services.enabledProviders
  const enabledProviders =
    providerList.length > 0 ? { enabledProviders: providerList } : {}

  const { auth } = request
  if (!auth.userId) {
    return { authenticated: false, roles: [], ...enabledProviders }
  }
  const user = await services.users.findById(auth.userId)
  if (!user) {
    return { authenticated: false, roles: [], ...enabledProviders }
  }

  const csrf = webCsrfToken(request, reply, services)

  return {
    authenticated: true,
    user: toUserDTO(user),
    roles: auth.roles,
    ...enabledProviders,
    ...(csrf !== null ? { csrfToken: csrf } : {}),
  }
}

function webCsrfToken(
  request: FastifyRequest,
  reply: FastifyReply,
  services: AuthServices,
): string | null {
  if (bearerToken(request) !== null) return null

  const existing = request.cookies[CSRF_COOKIE]
  if (existing && existing.length > 0) return existing

  const token = generateCsrfToken()
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

function isAllowedPostLoginRedirect(redirect: string, webOrigins: readonly string[]): boolean {
  const value = redirect.trim()
  if (value === "") return false
  if (value.startsWith("/")) {
    return !value.startsWith("//") && !value.startsWith("/\\")
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
