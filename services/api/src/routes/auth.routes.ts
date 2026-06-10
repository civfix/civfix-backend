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
import { ZodError, type ZodTypeAny, type z } from "zod"
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import type { Container } from "../di.js"
import type { AuthServices } from "../auth/auth-services.js"
import { toUserDTO } from "../auth/auth-services.js"
import { requireAuth } from "../auth/context.js"
import { csrfProtect, generateCsrfToken, setCsrfCookie, clearCsrfCookie } from "../auth/csrf.js"
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
  container: Container,
): Promise<void> {
  const services = app.authServices
  const webOrigins = container.env.WEB_ORIGINS

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
    // request.ip is the real client (trusted-proxy enforced; see server.ts) so the per-IP verify
    // throttle keys on the genuine network, not a spoofable X-Forwarded-For.
    const userId = await services.otp.verifyOtp(body.email, body.code, request.ip || null)
    await issueSession(services, request, reply, userId)
  })

  // -------------------------------------------------------------------------
  // Apple / Google (mobile token flows)
  // -------------------------------------------------------------------------

  app.post("/auth/apple", async (request, reply) => {
    const body = parse(AppleSignInRequestSchema, request.body)
    // P2-3: bind the nonce when the client supplied one (closes ID-token replay within the expiry).
    const user = await services.oauth.signInWithAppleIdToken(
      body.identityToken,
      body.fullName,
      body.nonce,
    )
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
    const startQuery = parse(OAuthStartQuerySchema, request.query)
    // P2-2 (open-redirect prevention): validate the post-login `redirect` target against the WEB_ORIGINS
    // allowlist (or accept a safe relative internal path) BEFORE stashing it, so the callback can only
    // ever bounce the browser to a trusted location. A disallowed value is a 422.
    if (startQuery.redirect !== undefined && !isAllowedPostLoginRedirect(startQuery.redirect, webOrigins)) {
      throw AppError.validation({ redirect: "must be an allowed origin or a relative path" })
    }
    const auth = services.oauth.createGoogleAuthUrl()
    // Stash state + PKCE verifier + the validated post-login redirect in a signed, httpOnly, short-lived
    // cookie. The callback validates the state, then sends the browser on to `redirect` after sign-in.
    const stash: OAuthStash = {
      state: auth.state,
      codeVerifier: auth.codeVerifier,
      ...(startQuery.redirect !== undefined ? { redirect: startQuery.redirect } : {}),
    }
    reply.setCookie(OAUTH_STATE_COOKIE, JSON.stringify(stash), {
      signed: true,
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: OAUTH_STATE_TTL_SECONDS,
    })
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
    // The browser reached this URL via a top-level navigation (not a fetch), so we establish the WEB
    // cookie session and then 302 the user back to the app origin they started from (validated at /start),
    // defaulting to the first WEB_ORIGINS entry. The SPA hydrates its session via GET /auth/session there.
    const target = resolvePostLoginRedirect(stash.redirect, webOrigins)
    await issueSessionForUser(services, request, reply, user, {
      forceKind: "web",
      webRedirectTo: target,
    })
  })

  // -------------------------------------------------------------------------
  // Session check + logout
  // -------------------------------------------------------------------------

  app.get("/auth/session", async (request, reply) => {
    const payload = await buildSessionCheck(services, request, reply)
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

  // -------------------------------------------------------------------------
  // First-run registration: username availability + profile completion
  // -------------------------------------------------------------------------

  // GET /me/handle-available?handle=  [auth]  - is this username free for me to take?
  app.get("/me/handle-available", async (request, reply) => {
    const userId = requireAuth(request)
    const { handle } = parse(HandleAvailableRequestSchema, request.query)
    if (!isValidHandle(handle)) {
      const payload: HandleAvailableResponse = { available: false, reason: "invalid" }
      reply.status(200).send(payload)
      return
    }
    const existing = await services.users.findByHandle(handle.trim())
    // Free if unclaimed, or already claimed by the asking user (idempotent re-check).
    const available = existing === null || existing.id === userId
    const payload: HandleAvailableResponse = available
      ? { available: true, reason: null }
      : { available: false, reason: "taken" }
    reply.status(200).send(payload)
  })

  // PUT /me/profile  [auth][csrf]  - finish first-run registration (set username + display name).
  app.put("/me/profile", { preHandler: csrfProtect }, async (request, reply) => {
    const userId = requireAuth(request)
    const body = parse(UpdateProfileRequestSchema, request.body)
    // Reject a username already owned by someone else (the schema enforces the format; this is the
    // uniqueness gate, racing the partial-unique index for the rare concurrent-claim case).
    const existing = await services.users.findByHandle(body.handle)
    if (existing !== null && existing.id !== userId) {
      throw AppError.conflict("That username is taken.")
    }
    const updated = await services.users.updateProfile(userId, {
      handle: body.handle,
      displayName: body.displayName,
    })
    const payload: UpdateProfileResponse = { user: toUserDTO(updated) }
    reply.status(200).send(payload)
  })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Options shared by the session-issuing helpers. */
interface IssueSessionOptions {
  /** Force a transport regardless of the X-Client header (the Google web callback forces "web"). */
  forceKind?: ClientKind
  /**
   * WEB transport only: after setting the session + CSRF cookies, 302-redirect the browser here instead
   * of returning the SessionResponse JSON. Used by the Google web callback (a top-level browser
   * navigation) to send the user back to the app. Ignored for the mobile bearer transport.
   */
  webRedirectTo?: string
}

/** Create a session for a userId and render the transport-appropriate SessionResponse. */
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

/** Create a session for an already-loaded user row and render the SessionResponse (or web redirect). */
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
    // Bearer transport: token in the body, no cookies.
    const payload: SessionResponse = { user: dto, token }
    reply.status(200).send(payload)
    return
  }

  // Web transport: httpOnly session cookie + readable CSRF cookie. No token in the body.
  setSessionCookie(reply, token, ttl)
  const csrfToken = generateCsrfToken()
  setCsrfCookie(reply, csrfToken, ttl)
  if (opts.webRedirectTo !== undefined) {
    // Top-level browser navigation (OAuth callback): the cookies above ride on the 302 response and the
    // SPA hydrates its session via GET /auth/session on arrival. No JSON body is returned.
    reply.redirect(opts.webRedirectTo)
    return
  }
  const payload: SessionResponse = { user: dto, csrfToken }
  reply.status(200).send(payload)
}

/**
 * Build the /auth/session response from the resolved req.auth (Redis-backed) + the user row.
 *
 * CSRF recovery (web only): for an AUTHENTICATED WEB (cookie) client we include the current csrfToken
 * in the response so the SPA can recover it after a page reload or an OAuth redirect, when only
 * GET /auth/session runs and the sign-in response (which normally carries csrfToken) was never seen by
 * JS. We read it from the readable CSRF cookie; if that cookie is missing/empty (e.g. it expired, or
 * the OAuth callback set the session before a CSRF cookie existed), we MINT one and set the cookie here
 * so the returned field and the cookie stay consistent (the double-submit pair the SPA will echo).
 * MOBILE (bearer) requests are unaffected: they carry no cookie and use no CSRF, so csrfToken is
 * omitted for them (and for unauthenticated callers).
 */
async function buildSessionCheck(
  services: AuthServices,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<SessionCheckResponse> {
  // Best-effort: tell the web which sign-in buttons to show. Omitted when none are configured.
  const enabledProviders =
    services.enabledProviders.length > 0
      ? { enabledProviders: services.enabledProviders }
      : {}

  const { auth } = request
  if (!auth.userId) {
    return { authenticated: false, roles: [], ...enabledProviders }
  }
  const user = await services.users.findById(auth.userId)
  if (!user) {
    // The session resolved but the user row is gone; treat as unauthenticated.
    return { authenticated: false, roles: [], ...enabledProviders }
  }

  // For the WEB cookie flow, surface the CSRF token so the SPA can recover it post-reload/redirect.
  const csrf = webCsrfToken(request, reply, services)

  return {
    authenticated: true,
    user: toUserDTO(user),
    roles: auth.roles,
    ...enabledProviders,
    ...(csrf !== null ? { csrfToken: csrf } : {}),
  }
}

/**
 * Resolve the CSRF token to return for an authenticated session check, or null for the bearer (mobile)
 * transport. WEB is detected as "no bearer token" (the same rule csrfProtect uses): we read the
 * readable CSRF cookie and, when absent, mint + set one so the field and cookie are consistent.
 */
function webCsrfToken(
  request: FastifyRequest,
  reply: FastifyReply,
  services: AuthServices,
): string | null {
  // Bearer (mobile) transport: no cookie, no CSRF. Omit the field entirely.
  if (bearerToken(request) !== null) return null

  const existing = request.cookies[CSRF_COOKIE]
  if (existing && existing.length > 0) return existing

  // No CSRF cookie yet on a cookie-authenticated session: mint one and set it so the SPA's next
  // state-changing request has a matching cookie+header pair. Cookie lifetime matches the session TTL.
  const token = generateCsrfToken()
  setCsrfCookie(reply, token, services.sessions.ttl)
  return token
}

interface OAuthStash {
  state: string
  codeVerifier: string
  /** The validated post-login redirect target (where to send the browser after sign-in). */
  redirect?: string
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
      return {
        state: parsed.state,
        codeVerifier: parsed.codeVerifier,
        ...(typeof parsed.redirect === "string" ? { redirect: parsed.redirect } : {}),
      }
    }
    return null
  } catch {
    return null
  }
}

/**
 * Resolve where to send the browser after a successful Google web sign-in. Prefers the `redirect` target
 * captured at /start (re-validated here as defense-in-depth, even though the stash cookie is signed),
 * falling back to the first WEB_ORIGINS entry, then the site root. PURE. Exported for unit testing.
 */
export function resolvePostLoginRedirect(
  redirect: string | undefined,
  webOrigins: readonly string[],
): string {
  if (redirect !== undefined && isAllowedPostLoginRedirect(redirect, webOrigins)) {
    return redirect
  }
  return webOrigins[0] ?? "/"
}

/**
 * Whether a post-login `redirect` target is safe (P2-2 open-redirect guard). Allowed:
 *   - a RELATIVE internal path: starts with a single "/" but NOT "//" or "/\" (those are
 *     protocol-relative / backslash tricks that browsers treat as absolute -> open redirect), and
 *   - an ABSOLUTE URL whose ORIGIN exactly matches an entry in the WEB_ORIGINS allowlist.
 * Everything else (other hosts, javascript:, data:, malformed) is rejected. PURE.
 */
function isAllowedPostLoginRedirect(redirect: string, webOrigins: readonly string[]): boolean {
  const value = redirect.trim()
  if (value === "") return false
  // Relative internal path: exactly one leading slash, and not a backslash trick.
  if (value.startsWith("/")) {
    return !value.startsWith("//") && !value.startsWith("/\\")
  }
  // Absolute URL: its origin must be allowlisted.
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false
  return webOrigins.includes(url.origin)
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
