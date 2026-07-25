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
 *   POST /admin/auth/logout           [public]  revoke the app session, clear both cookies, and audit
 *                                               "operator.logout" (best-effort) when the caller held an
 *                                               operator session; idempotent, so a stale tab can always
 *                                               clean itself up (the SPA also navigates to
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
import { resolveLocale } from "../../i18n/locales.js"
import { isAdminEmail } from "../../auth/admin-allowlist.js"
import { createAccessVerifier, type AccessIdentity, type VerifyAccessJwt } from "../../auth/cf-access.js"
import { writeAudit, type WriteAuditInput } from "../../services/admin/audit.js"
import {
  generateCsrfToken,
  setCsrfCookie,
  clearCsrfCookie,
  type Csrf,
} from "../../auth/csrf.js"
import {
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
 *  - `auditSink` captures the operator session audits (operator.login from the exchange, operator.logout
 *    from logout) instead of writing through container.getDb() (the offline auth harness has no DB), so
 *    both gates are assertable. NOTE the logout write is best-effort: a sink that REJECTS is swallowed
 *    there by design, so a test asserting the row must use a resolving sink.
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
  // ONE csrf instance for both halves: the exchange mints with it and the mutations verify with it, so
  // both read the key this container was built from (see auth/csrf.ts).
  const csrf = container.csrf
  const csrfProtect = csrf.protect

  // Build the Access JWT verifier ONCE (it caches the remote JWKS + auto-rotates). Null when Access is
  // not configured; the exchange then fails loudly (503) instead of silently accepting nothing. A test
  // override (app.adminAuthOverrides.verifyAccessJwt) takes precedence so the route is testable offline.
  const teamDomain = env.CF_ACCESS_TEAM_DOMAIN
  const aud = env.CF_ACCESS_AUD
  const defaultVerify: VerifyAccessJwt | null =
    teamDomain && aud ? createAccessVerifier({ teamDomain, aud }) : null

  /**
   * Find-or-create the operator by verified email, ensure the operator role, and audit the login.
   *
   * The find-then-create below is NOT a lost-update hazard on a double-submitted first login:
   * UserStore.create is itself an upsert (INSERT ... ON CONFLICT (email) DO NOTHING, then re-read), so the
   * loser of the race converges on the winner's row instead of surfacing a unique violation.
   */
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
    await auditOperatorAuth(app, container, {
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
    const payload = await establishOperatorSession(services, csrf, request, reply, operator)
    reply.status(200).send(payload)
  })

  route(app, "adminSession", async (request, reply) => {
    const payload = await buildAdminSession(services, csrf, request, reply)
    reply.status(200).send(payload)
  })

  /**
   * Keyed on the PRESENTED credential, not on a resolved session — the same rule as the citizen logout
   * (routes/auth.routes.ts):
   *   - a token that no longer resolves (expired / revoked / banned) is still logged out best-effort, and
   *     the cookies ARE cleared. requireAuth would 401 that caller and leave the stale tab's dead session
   *     + CSRF cookies in the browser forever — the one thing logout exists to clean up;
   *   - a request carrying NO credential has nothing to revoke and nothing of its own to clear, so it stays
   *     401, which is what the contract's `adminLogout.auth === "required"` pins. Answering 200 to an
   *     anonymous POST made this half of the refactor disagree with its citizen twin.
   * CSRF is unaffected: a cross-site POST bearing the victim's cookies DOES present a session cookie, so
   * csrfProtect enforced the session-bound token before this handler ran.
   */
  route(app, "adminLogout", { preHandler: csrfProtect, config: { rateLimit: ADMIN_AUTH_RATE_LIMIT } }, async (request, reply) => {
    const token = presentedSessionToken(request)
    if (token === null) {
      throw AppError.unauthorized()
    }
    // Read the actor BEFORE the revoke: afterwards the session is gone and there is nothing left to
    // attribute the audit row to.
    const { userId, roles } = request.auth
    await services.sessions.revokeSession(token)
    clearSessionCookie(reply)
    clearCsrfCookie(reply)
    // `operator.logout` was in the AdminAuditAction catalogue but never written, so the audit log could
    // answer "who signed in" and never "who signed out" — the closing half of every operator session.
    //
    // AFTER the revoke and best-effort: this route's job is to leave no live session behind, so a failing
    // audit write must not abort it (that would clear the cookies while the session stayed live, i.e. an
    // unrevokable session). Only an authenticated OPERATOR is recorded: a presented-but-dead token has no
    // resolved actor — a NULL-actor row would read as a system action.
    if (userId !== null && roles.includes("operator")) {
      await auditOperatorAuth(app, container, {
        actorId: userId,
        action: "operator.logout",
        target: `user:${userId}`,
        // A live session was actually killed. Always true HERE by construction: an actor only resolves
        // when the presented token was still live at the onRequest hook, and a stale tab clearing its own
        // dead cookies resolves none and writes no row at all. Kept explicit so the audit row states what
        // happened rather than leaving the reader to infer it. The token is a credential; never recorded.
        meta: { sessionRevoked: true },
      }).catch((err: unknown) => {
        request.log.warn({ err }, "operator.logout audit write failed")
      })
    }
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
 * Write an operator session audit (operator.login on the exchange, operator.logout on logout). Uses the
 * injected sink when present (tests: the offline harness has no DB), else the raw sql tag (production).
 * Keeping the audit write here (not skipped) means production always records both ends of a session; the
 * sink lets a unit/HTTP test assert them.
 */
async function auditOperatorAuth(
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
  csrf: Csrf,
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
  // Session-BOUND, like the citizen surface: the CSRF token is an HMAC over the session, so it proves the
  // holder owns this session rather than merely being able to read a cookie on the domain. It is also
  // deterministic, which is what makes the reuse branch in buildAdminSession work.
  const csrfToken = await csrf.tokenForSession(token)
  setCsrfCookie(reply, csrfToken, ttl)
  return { user: toUserPayload(user), csrfToken }
}

/**
 * Build the GET /admin/auth/session response from the resolved req.auth (Redis-backed). Returns the
 * operator identity only for an authenticated session whose role is operator; anything else is
 * unauthenticated. For the web cookie flow the session-bound CSRF token is re-derived and re-set so the
 * SPA can recover it after a reload, mirroring the Phase 1 session route.
 */
async function buildAdminSession(
  services: AuthServices,
  csrf: Csrf,
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
  //
  // ALWAYS RE-DERIVED from the presented session, never echoed back from the CSRF cookie — the same
  // stance as the citizen session route (routes/auth.routes.ts webCsrfToken). The old echo-the-cookie
  // branch existed because the token used to be a fresh RANDOM value on every bootstrap, which rotated it
  // out from under a tab still holding the previous one (and read the pre-`__Host-` cookie name, so in
  // production it never even fired). A session-bound token is DETERMINISTIC, so re-deriving returns the
  // byte-identical value for any legitimately-bound cookie and there is nothing left to rotate.
  //
  // Re-deriving is also what HEALS a stale cookie: a browser still holding a pre-binding random value (or
  // one planted by a cookie-writing sibling origin) would otherwise be handed that value back on every
  // poll — and since nothing verifies it any more, the console would 403 on every mutation with no way
  // out. The overwrite below replaces it with the token this session's mutations actually require.
  const sessionToken = presentedSessionToken(request)
  const token = sessionToken ? await csrf.tokenForSession(sessionToken) : generateCsrfToken()
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
    // Required UserDTO field since @civfix/shared 0.22 (i18n); clamp the stored column to a supported code.
    locale: resolveLocale(user.locale),
  }
}

/** Best-effort display name for a freshly provisioned operator: the email local-part, else "Operator". */
function deriveOperatorName(email: string): string {
  const at = email.indexOf("@")
  const local = at > 0 ? email.slice(0, at) : email
  return local.length > 0 ? local : "Operator"
}
