/**
 * Admin / operator authentication routes (Phase 2, Cloudflare Access SSO — doc 16).
 *
 * Authentication is delegated to Cloudflare Access (Zero Trust). The bespoke admin Email-OTP front door
 * has been removed; the ONLY way to obtain an operator session is the Access exchange below, which reads
 * and cryptographically verifies the edge-injected `Cf-Access-Jwt-Assertion` header. `ADMIN_EMAILS`
 * remains the in-app AUTHORIZATION allowlist (checked against the verified email). These are the only
 * /admin/* routes NOT behind the requireOperator guard (they establish the operator session);
 * routes/admin/index.ts registers them unguarded and applies the guard to every data router.
 *
 *   POST /admin/auth/access/exchange  [public]  credentialed same-origin fetch from the SPA. The SPA is
 *                                               served behind the same Cloudflare Access app as the API
 *                                               (admin.civfix.org → Caddy → SPA + /admin/*), so by the
 *                                               time the SPA loads the request already carries the Access
 *                                               cookie and the edge injects `Cf-Access-Jwt-Assertion`.
 *                                               This route verifies that JWT, maps the email to the
 *                                               operator role (allowlist-gated, find-or-create the user),
 *                                               audits "operator.login", and mints a Phase 1 web session;
 *                                               returns the AdminLoginResponse. 503 when Access is not
 *                                               configured; 401 missing/invalid JWT; 403 not allowlisted.
 *   GET  /admin/auth/session          [public]  current operator {id,name,email,role} or unauthenticated.
 *   POST /admin/auth/logout           [public]  revoke the app session (the SPA also navigates to
 *                                               /cdn-cgi/access/logout to end the Access session).
 *
 * Transport is the WEB cookie flow (the dashboard is a browser SPA): the exchange + logout responses set
 * / clear the httpOnly session cookie + the readable CSRF cookie exactly like the Phase 1 auth routes.
 */

import {
  AppError,
  ErrorCode,
  type AdminLoginResponse,
  type AdminOperatorDTO,
  type AdminSessionResponse,
  type AdminLogoutResponse,
} from "@civfix/shared"
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import type { Container } from "../../di.js"
import type { AuthServices } from "../../auth/auth-services.js"
import type { UserRecord } from "../../auth/stores.js"
import { requireAuth } from "../../auth/context.js"
import { isAdminEmail } from "../../auth/admin-allowlist.js"
import { createAccessVerifier, type AccessIdentity, type VerifyAccessJwt } from "../../auth/cf-access.js"
import { writeAudit, type WriteAuditInput } from "../../services/admin/audit.js"
import { csrfProtect, generateCsrfToken, setCsrfCookie, clearCsrfCookie } from "../../auth/csrf.js"
import {
  CSRF_COOKIE,
  presentedSessionToken,
  setSessionCookie,
  clearSessionCookie,
} from "../../auth/transport.js"
import { route } from "../../versioning/route.js"

// Tighter than the global 300/min: the exchange verifies a JWT + mints an operator session (CF Access
// fronts it in prod, but defense-in-depth at the app layer).
const ADMIN_AUTH_RATE_LIMIT = { max: 10, timeWindow: "1 minute" } as const

/**
 * Optional injected admin-auth overrides (tests).
 *  - `auditSink` captures the operator.login audit instead of writing through container.getDb() (the
 *    offline auth harness has no DB), so the "exchange writes operator.login" gate is assertable.
 *  - `verifyAccessJwt` substitutes the Cloudflare Access verifier so the exchange route can be HTTP-tested
 *    offline with a locally minted token (the real verifier fetches a remote JWKS).
 */
export interface AdminAuthOverrides {
  auditSink(input: WriteAuditInput): Promise<void>
  verifyAccessJwt?: VerifyAccessJwt
}

declare module "fastify" {
  interface FastifyInstance {
    /** Injected admin-auth overrides (tests). See AdminAuthOverrides. */
    adminAuthOverrides?: AdminAuthOverrides
  }
}

/**
 * Register the operator auth routes. `container` supplies the env (the ADMIN_EMAILS allowlist, the
 * CF_ACCESS_* config, and the DB handle used by the audit write); the auth bundle is read off the app
 * (decorated in server.ts), matching the Phase 1 auth plugin.
 */
export async function registerAdminAuthRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  const services = app.authServices
  const env = container.env

  // Build the Access JWT verifier ONCE (it caches the remote JWKS + auto-rotates). Null when Access is
  // not configured; the exchange then fails loudly (503) instead of silently accepting nothing. A test
  // override (app.adminAuthOverrides.verifyAccessJwt) takes precedence so the route is testable offline.
  const teamDomain = env.CF_ACCESS_TEAM_DOMAIN
  const aud = env.CF_ACCESS_AUD
  const defaultVerify: VerifyAccessJwt | null =
    teamDomain && aud ? createAccessVerifier({ teamDomain, aud }) : null

  /** Find-or-create the operator by verified email, ensure the operator role, and audit the login. */
  async function provisionOperator(email: string): Promise<UserRecord> {
    let user = await services.users.findByEmail(email)
    if (!user) {
      user = await services.users.create(email, {
        displayName: deriveOperatorName(email),
        role: "operator",
        emailVerified: true, // Cloudflare Access verified the email at the IdP.
      })
    }
    const operator =
      user.role === "operator" ? user : await services.users.setRole(user.id, "operator")
    await auditLogin(app, container, {
      actorId: operator.id,
      action: "operator.login",
      target: `user:${operator.id}`,
      meta: { email: operator.email, via: "cf-access" },
    })
    return operator
  }

  route(app, "adminAccessExchange", { config: { rateLimit: ADMIN_AUTH_RATE_LIMIT } }, async (request, reply) => {
    const verify = app.adminAuthOverrides?.verifyAccessJwt ?? defaultVerify
    if (!verify) {
      throw new AppError(ErrorCode.INTERNAL, "Cloudflare Access is not configured.", {
        httpStatus: 503,
      })
    }
    const identity = await verifyHeader(verify, request)
    const email = identity.email?.toLowerCase()
    if (!email || !isAdminEmail(env, email)) {
      throw AppError.forbidden("This account is not authorized for the operator dashboard.")
    }
    const operator = await provisionOperator(email)
    const payload = await establishOperatorSession(services, request, reply, operator)
    reply.status(200).send(payload)
  })

  route(app, "adminSession", async (request, reply) => {
    const payload = await buildAdminSession(services, request, reply)
    reply.status(200).send(payload)
  })

  route(app, "adminLogout", { preHandler: csrfProtect, config: { rateLimit: ADMIN_AUTH_RATE_LIMIT } }, async (request, reply) => {
    requireAuth(request)
    const token = presentedSessionToken(request)
    if (token) {
      await services.sessions.revokeSession(token)
    }
    clearSessionCookie(reply)
    clearCsrfCookie(reply)
    const payload: AdminLogoutResponse = { ok: true }
    reply.status(200).send(payload)
  })
}

/** Read + verify the `Cf-Access-Jwt-Assertion` header; 401 on absent or invalid token. */
async function verifyHeader(
  verify: VerifyAccessJwt,
  request: FastifyRequest,
): Promise<AccessIdentity> {
  const token = request.headers["cf-access-jwt-assertion"]
  if (typeof token !== "string" || token.length === 0) throw AppError.unauthorized()
  try {
    return await verify(token)
  } catch {
    throw AppError.unauthorized()
  }
}

/**
 * Write the operator.login audit. Uses the injected sink when present (tests: the offline harness has no
 * DB), else the raw sql tag (production). Keeping the audit write here (not skipped) means production
 * always records the login; the sink lets a unit/HTTP test assert it.
 */
async function auditLogin(
  app: FastifyInstance,
  container: Container,
  input: WriteAuditInput,
): Promise<void> {
  const overrides = app.adminAuthOverrides
  if (overrides) {
    await overrides.auditSink(input)
    return
  }
  await writeAudit(container.getDb().sql, input)
}

/**
 * Create a WEB session for the operator and return the AdminLoginResponse (= Phase 1 SessionResponse:
 * httpOnly session cookie + readable CSRF cookie set on the reply, csrfToken echoed in the body). The
 * dashboard is a browser SPA, so the cookie transport is forced regardless of X-Client.
 */
async function establishOperatorSession(
  services: AuthServices,
  request: FastifyRequest,
  reply: FastifyReply,
  user: UserRecord,
): Promise<AdminLoginResponse> {
  const token = await services.sessions.createSession(user.id, [user.role], {
    userAgent: request.headers["user-agent"] ?? null,
    ip: request.ip || null,
  })
  const ttl = services.sessions.ttl
  setSessionCookie(reply, token, ttl)
  const csrfToken = generateCsrfToken()
  setCsrfCookie(reply, csrfToken, ttl)
  return { user: toUserPayload(user), csrfToken }
}

/**
 * Build the GET /admin/auth/session response from the resolved req.auth (Redis-backed). Returns the
 * operator identity only for an authenticated session whose role is operator; anything else is
 * unauthenticated. For the web cookie flow the current CSRF token is surfaced so the SPA can recover it
 * after a reload (minting + setting one when the cookie is absent, mirroring the Phase 1 session route).
 */
async function buildAdminSession(
  services: AuthServices,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<AdminSessionResponse> {
  const { auth } = request
  if (!auth.userId || !auth.roles.includes("operator")) {
    return { authenticated: false }
  }
  const user = await services.users.findById(auth.userId)
  if (!user || user.role !== "operator") {
    return { authenticated: false }
  }

  const operator: AdminOperatorDTO = {
    id: user.id,
    name: user.displayName,
    email: user.email ?? "",
    role: user.role,
  }

  // Web cookie flow: surface/refresh the CSRF token so the SPA can echo it on state-changing calls.
  const existing = request.cookies[CSRF_COOKIE]
  if (existing && existing.length > 0) {
    return { authenticated: true, operator, csrfToken: existing }
  }
  const token = generateCsrfToken()
  setCsrfCookie(reply, token, services.sessions.ttl)
  return { authenticated: true, operator, csrfToken: token }
}

/** Project a user row into the SessionResponse `user` payload (the Phase 1 UserDTO shape). */
function toUserPayload(user: UserRecord): AdminLoginResponse["user"] {
  return {
    id: user.id,
    displayName: user.displayName,
    handle: user.handle,
    email: user.email,
    avatarUrl: user.avatarUrl,
    profileComplete: user.profileComplete,
    role: user.role,
    createdAt: user.createdAt.toISOString(),
  }
}

/** Best-effort display name for a freshly provisioned operator: the email local-part, else "Operator". */
function deriveOperatorName(email: string): string {
  const at = email.indexOf("@")
  const local = at > 0 ? email.slice(0, at) : email
  return local.length > 0 ? local : "Operator"
}
