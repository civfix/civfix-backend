/**
 * Admin / operator authentication routes (Phase 2).
 *
 * Dedicated, allowlist-gated Email-OTP routes that reuse the Phase 1 OtpService + SessionService but
 * stay isolated from citizen auth. These are the ONLY /admin/* routes that are NOT behind the
 * requireOperator guard (they establish the operator session); routes/admin/index.ts registers them
 * unguarded and applies the guard to every data router.
 *
 *   POST /admin/auth/otp/request {email}  [public]  if the email is NOT allowlisted, return the
 *                                                    generic {sent:true} WITHOUT issuing (no email
 *                                                    enumeration); else issue via OtpService.
 *   POST /admin/auth/otp/verify  {email,code} [public]  re-check the allowlist FIRST (a non-allowlisted
 *                                                    email is forbidden and creates NO user row, V2);
 *                                                    then verify via OtpService (find-or-creates the user
 *                                                    by email), grant the operator role (idempotent) +
 *                                                    audit "operator.login"; then issue a Phase 1 session
 *                                                    (web cookie + CSRF).
 *   GET  /admin/auth/session     [public]  current operator {id,name,email,role} or unauthenticated.
 *   POST /admin/auth/logout      [public]  revoke the session (reuses the Phase 1 logout/CSRF).
 *
 * Transport is the WEB cookie flow (the dashboard is a browser SPA): the verify + logout responses set
 * / clear the httpOnly session cookie + the readable CSRF cookie exactly like the Phase 1 auth routes.
 */

import {
  AdminOtpRequestRequestSchema,
  AdminOtpVerifyRequestSchema,
  AppError,
  type AdminOtpRequestResponse,
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
import { OTP_EMAIL_WINDOW_SECONDS } from "../../auth/otp.js"
import { writeAudit, type WriteAuditInput } from "../../services/admin/audit.js"
import { parse } from "./_route-utils.js"
import { csrfProtect, generateCsrfToken, setCsrfCookie, clearCsrfCookie } from "../../auth/csrf.js"
import {
  CSRF_COOKIE,
  presentedSessionToken,
  setSessionCookie,
  clearSessionCookie,
} from "../../auth/transport.js"

/**
 * Optional injected admin-auth overrides (tests). When an `auditSink` is present the operator.login audit
 * is captured here instead of writing through container.getDb() (the offline auth harness has no DB), so
 * the "verify writes operator.login" gate is assertable in a unit/HTTP test (H3). Production leaves this
 * unset and the audit is written via writeAudit on the raw sql tag.
 */
export interface AdminAuthOverrides {
  auditSink(input: WriteAuditInput): Promise<void>
}

declare module "fastify" {
  interface FastifyInstance {
    /** Injected admin-auth overrides (tests). See AdminAuthOverrides. */
    adminAuthOverrides?: AdminAuthOverrides
  }
}

/**
 * Register the operator auth routes. `container` supplies the env (for the ADMIN_EMAILS allowlist and
 * the DB handle used by the audit write) and the auth bundle is read off the app (decorated in
 * server.ts), matching the Phase 1 auth plugin.
 */
export async function registerAdminAuthRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  const services = app.authServices
  const env = container.env

  // -------------------------------------------------------------------------
  // POST /admin/auth/otp/request  [public]
  // -------------------------------------------------------------------------
  app.post("/admin/auth/otp/request", async (request, reply) => {
    const body = parse(AdminOtpRequestRequestSchema, request.body)
    // NO ENUMERATION (M7): a non-allowlisted email gets a byte-for-byte identical ack to an allowlisted
    // one - same { sent:true } shape AND the same resendAfterSec value (the OtpService's configured resend
    // window). The previous constant 0 was a side channel that revealed allowlist membership. No code is
    // issued for a non-allowlisted email; only allowlisted emails trigger OtpService.issueOtp.
    if (!isAdminEmail(env, body.email)) {
      const payload: AdminOtpRequestResponse = {
        sent: true,
        resendAfterSec: OTP_EMAIL_WINDOW_SECONDS,
      }
      reply.status(200).send(payload)
      return
    }
    const result = await services.otp.issueOtp(body.email, request.ip || null)
    const payload: AdminOtpRequestResponse = { sent: true, resendAfterSec: result.resendAfterSec }
    reply.status(200).send(payload)
  })

  // -------------------------------------------------------------------------
  // POST /admin/auth/otp/verify  [public]
  // -------------------------------------------------------------------------
  app.post("/admin/auth/otp/verify", async (request, reply) => {
    const body = parse(AdminOtpVerifyRequestSchema, request.body)

    // Allowlist re-check FIRST (V2), BEFORE OtpService.verifyOtp find-or-creates the user: a
    // non-allowlisted email that presents a valid code must NOT create even a bare user row. We reject it
    // here with the same forbidden behavior as the post-verify re-check used to, so no user is provisioned
    // for an email that can never become an operator (e.g. ADMIN_EMAILS changed between request and
    // verify). The request path's no-enumeration property is untouched (verify already returned forbidden
    // for a non-allowlisted email; this only moves the check ahead of the find-or-create side effect).
    if (!isAdminEmail(env, body.email)) {
      throw AppError.forbidden("This account is not authorized for the operator dashboard.")
    }

    // OtpService.verifyOtp find-or-creates the user by email and returns the userId on a correct code;
    // it throws the generic unauthorized envelope on any failure (no code, wrong code, throttled).
    const userId = await services.otp.verifyOtp(body.email, body.code, request.ip || null)

    const user = await services.users.findById(userId)
    if (!user) {
      throw AppError.internal("User vanished after sign-in.")
    }

    // Grant the operator role idempotently (no-op when already operator) and audit the login. The audit
    // write uses the raw sql tag (container.getDb().sql), the canonical accessor for hand-written SQL; a
    // test override captures it instead (the offline harness has no DB).
    const operator =
      user.role === "operator" ? user : await services.users.setRole(user.id, "operator")
    await auditLogin(app, container, {
      actorId: operator.id,
      action: "operator.login",
      target: `user:${operator.id}`,
      meta: { email: operator.email },
    })

    // Issue a Phase 1 web session (cookie + CSRF), exactly like the citizen verify route.
    await issueOperatorSession(services, request, reply, operator)
  })

  // -------------------------------------------------------------------------
  // GET /admin/auth/session  [public]
  // -------------------------------------------------------------------------
  app.get("/admin/auth/session", async (request, reply) => {
    const payload = await buildAdminSession(services, request, reply)
    reply.status(200).send(payload)
  })

  // -------------------------------------------------------------------------
  // POST /admin/auth/logout  [public]  (reuses the Phase 1 logout/CSRF)
  // -------------------------------------------------------------------------
  app.post("/admin/auth/logout", { preHandler: csrfProtect }, async (request, reply) => {
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
 * Create a WEB session for the operator and render the AdminLoginResponse (= Phase 1 SessionResponse:
 * httpOnly session cookie + readable CSRF cookie, csrfToken echoed in the body). The dashboard is a
 * browser SPA, so the cookie transport is forced regardless of X-Client.
 */
async function issueOperatorSession(
  services: AuthServices,
  request: FastifyRequest,
  reply: FastifyReply,
  user: UserRecord,
): Promise<void> {
  const token = await services.sessions.createSession(user.id, [user.role], {
    userAgent: request.headers["user-agent"] ?? null,
    ip: request.ip || null,
  })
  const ttl = services.sessions.ttl
  setSessionCookie(reply, token, ttl)
  const csrfToken = generateCsrfToken()
  setCsrfCookie(reply, csrfToken, ttl)
  const payload: AdminLoginResponse = { user: toUserPayload(user), csrfToken }
  reply.status(200).send(payload)
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
