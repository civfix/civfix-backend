/**
 * Auth route plugin.
 *
 * Endpoints (all bodies/queries validated against the @civfix/shared Zod schemas):
 *   POST /auth/apple          verify an Apple identity token, sign in / sign up.
 *   POST /auth/google         verify a Google ID token (mobile), sign in / sign up.
 *   GET  /auth/google/start   begin the Google web flow (Arctic auth URL + PKCE/state cookie).
 *   GET  /auth/google/callback complete the Google web flow.
 *   POST /auth/otp/request    issue an email OTP.
 *   POST /auth/otp/verify     verify an email OTP, sign in / sign up.
 *   GET  /auth/session        report the current session (Redis-backed via req.auth).
 *   POST /auth/logout         revoke the current session (requires auth + CSRF).
 *
 * Transport: every sign-in endpoint returns a SessionResponse whose shape depends on X-Client.
 * For web it sets the httpOnly session cookie + a readable CSRF cookie (and returns csrfToken). For
 * mobile it returns the bearer token in the body. See ./auth-transport for the rule.
 */

import {
  AppleSignInRequestSchema,
  GoogleSignInRequestSchema,
  EmailOtpRequestRequestSchema,
  EmailOtpVerifyRequestSchema,
  OAuthCallbackQuerySchema,
  OAuthStartQuerySchema,
  AppError,
  type SessionResponse,
  type SessionCheckResponse,
  type LogoutResponse,
  type EmailOtpRequestResponse,
  type UserDTO,
} from "@civfix/shared"
import { ZodError, type ZodTypeAny, type z } from "zod"
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import type { Container } from "../di.js"
import type { AuthServices } from "../auth/auth-services.js"
import { toUserDTO } from "../auth/auth-services.js"
import { requireAuth } from "../auth/context.js"
import { csrfProtect, generateCsrfToken, setCsrfCookie, clearCsrfCookie } from "../auth/csrf.js"
import {
  clientKind,
  presentedSessionToken,
  setSessionCookie,
  clearSessionCookie,
  type ClientKind,
} from "../auth/transport.js"
import type { UserRecord } from "../auth/stores.js"

/** Short-lived signed cookie holding the Google web flow's state + PKCE verifier. */
const OAUTH_STATE_COOKIE = "civfix_oauth"
/** OAuth handshake cookie lifetime (10 minutes is ample for a redirect round trip). */
const OAUTH_STATE_TTL_SECONDS = 10 * 60

/**
 * Register the auth routes under their own encapsulated plugin context, then expose it from the
 * caller. `authServices` is read off the app (decorated in server.ts) so this plugin stays pure
 * routing and works identically for the injected-test bundle and the production bundle.
 */
export async function registerAuthRoutes(
  app: FastifyInstance,
  _container: Container,
): Promise<void> {
  const services = app.authServices

  // -------------------------------------------------------------------------
  // Email OTP
  // -------------------------------------------------------------------------

  app.post("/auth/otp/request", async (request, reply) => {
    const body = parse(EmailOtpRequestRequestSchema, request.body)
    const result = await services.otp.issueOtp(body.email, request.ip || null)
    const payload: EmailOtpRequestResponse = { sent: true, resendAfterSec: result.resendAfterSec }
    reply.status(200).send(payload)
  })

  app.post("/auth/otp/verify", async (request, reply) => {
    const body = parse(EmailOtpVerifyRequestSchema, request.body)
    const userId = await services.otp.verifyOtp(body.email, body.code)
    await issueSession(services, request, reply, userId)
  })

  // -------------------------------------------------------------------------
  // Apple / Google (mobile token flows)
  // -------------------------------------------------------------------------

  app.post("/auth/apple", async (request, reply) => {
    const body = parse(AppleSignInRequestSchema, request.body)
    const user = await services.oauth.signInWithAppleIdToken(body.identityToken, body.fullName)
    await issueSessionForUser(services, request, reply, user)
  })

  app.post("/auth/google", async (request, reply) => {
    const body = parse(GoogleSignInRequestSchema, request.body)
    const user = await services.oauth.signInWithGoogleIdToken(body.idToken)
    await issueSessionForUser(services, request, reply, user)
  })

  // -------------------------------------------------------------------------
  // Google web (authorization-code + PKCE)
  // -------------------------------------------------------------------------

  app.get("/auth/google/start", async (request, reply) => {
    parse(OAuthStartQuerySchema, request.query)
    const auth = services.oauth.createGoogleAuthUrl()
    // Stash state + verifier in a signed, httpOnly, short-lived cookie for the callback to validate.
    reply.setCookie(
      OAUTH_STATE_COOKIE,
      JSON.stringify({ state: auth.state, codeVerifier: auth.codeVerifier }),
      {
        signed: true,
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
        maxAge: OAUTH_STATE_TTL_SECONDS,
      },
    )
    reply.redirect(auth.url)
  })

  app.get("/auth/google/callback", async (request, reply) => {
    const query = parse(OAuthCallbackQuerySchema, request.query)
    const stash = readOAuthStash(request)
    if (!stash || stash.state !== query.state) {
      throw AppError.unauthorized("Invalid OAuth state.")
    }
    reply.clearCookie(OAUTH_STATE_COOKIE, { path: "/" })
    const user = await services.oauth.completeGoogleCallback(query.code, stash.codeVerifier)
    // Web flow always uses the cookie transport regardless of X-Client.
    await issueSessionForUser(services, request, reply, user, "web")
  })

  // -------------------------------------------------------------------------
  // Session check + logout
  // -------------------------------------------------------------------------

  app.get("/auth/session", async (request, reply) => {
    const payload = await buildSessionCheck(services, request)
    reply.status(200).send(payload)
  })

  app.post("/auth/logout", { preHandler: csrfProtect }, async (request, reply) => {
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
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a session for a userId and render the transport-appropriate SessionResponse. */
async function issueSession(
  services: AuthServices,
  request: FastifyRequest,
  reply: FastifyReply,
  userId: string,
  forceKind?: ClientKind,
): Promise<void> {
  const user = await services.users.findById(userId)
  if (!user) {
    throw AppError.internal("User vanished after sign-in.")
  }
  await issueSessionForUser(services, request, reply, user, forceKind)
}

/** Create a session for an already-loaded user row and render the SessionResponse. */
async function issueSessionForUser(
  services: AuthServices,
  request: FastifyRequest,
  reply: FastifyReply,
  user: UserRecord,
  forceKind?: ClientKind,
): Promise<void> {
  const kind = forceKind ?? clientKind(request)
  const token = await services.sessions.createSession(user.id, [user.role], {
    userAgent: request.headers["user-agent"] ?? null,
    ip: request.ip || null,
  })
  const dto: UserDTO = toUserDTO(user)
  const ttl = services.sessions.ttl

  if (kind === "mobile") {
    // Bearer transport: token in the body, no cookies.
    const payload: SessionResponse = { user: dto, token }
    reply.status(200).send(payload)
    return
  }

  // Web transport: httpOnly session cookie + readable CSRF cookie. No token in the body.
  setSessionCookie(reply, token, ttl)
  const csrfToken = generateCsrfToken()
  setCsrfCookie(reply, csrfToken, ttl)
  const payload: SessionResponse = { user: dto, csrfToken }
  reply.status(200).send(payload)
}

/** Build the /auth/session response from the resolved req.auth (Redis-backed) + the user row. */
async function buildSessionCheck(
  services: AuthServices,
  request: FastifyRequest,
): Promise<SessionCheckResponse> {
  const { auth } = request
  if (!auth.userId) {
    return { authenticated: false, roles: [] }
  }
  const user = await services.users.findById(auth.userId)
  if (!user) {
    // The session resolved but the user row is gone; treat as unauthenticated.
    return { authenticated: false, roles: [] }
  }
  return { authenticated: true, user: toUserDTO(user), roles: auth.roles }
}

interface OAuthStash {
  state: string
  codeVerifier: string
}

/** Read + unsign the Google web flow stash cookie; null when absent or tampered. */
function readOAuthStash(request: FastifyRequest): OAuthStash | null {
  const raw = request.cookies[OAUTH_STATE_COOKIE]
  if (!raw) return null
  const unsigned = request.unsignCookie(raw)
  if (!unsigned.valid || unsigned.value === null) return null
  try {
    const parsed = JSON.parse(unsigned.value) as Partial<OAuthStash>
    if (typeof parsed.state === "string" && typeof parsed.codeVerifier === "string") {
      return { state: parsed.state, codeVerifier: parsed.codeVerifier }
    }
    return null
  } catch {
    return null
  }
}

/**
 * Validate `data` against a Zod schema, throwing AppError.validation (422 with field details) on
 * failure so the canonical error envelope is returned instead of a generic 500. Centralizes the
 * Zod-error -> AppError mapping for the auth routes.
 */
function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  try {
    return schema.parse(data)
  } catch (err) {
    if (err instanceof ZodError) {
      const fields: Record<string, string> = {}
      for (const issue of err.issues) {
        const key = issue.path.length > 0 ? issue.path.join(".") : "_"
        fields[key] = issue.message
      }
      throw AppError.validation(fields)
    }
    throw err
  }
}
