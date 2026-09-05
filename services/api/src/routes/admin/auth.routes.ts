
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
import { SUSPENDED_MESSAGE } from "../../auth/account-status.js"
import type { Env } from "../../env.js"
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

const ADMIN_AUTH_RATE_LIMIT = { max: 10, timeWindow: "1 minute" } as const

export interface AdminAuthOverrides {
  auditSink(input: WriteAuditInput): Promise<void>
  verifyAccessJwt?: VerifyAccessJwt
}

declare module "fastify" {
  interface FastifyInstance {
    adminAuthOverrides?: AdminAuthOverrides
  }
}

export async function registerAdminAuthRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  const services = app.authServices
  const env = container.env
  const csrf = container.csrf
  const csrfProtect = csrf.protect

  const teamDomain = env.CF_ACCESS_TEAM_DOMAIN
  const aud = env.CF_ACCESS_AUD
  const defaultVerify: VerifyAccessJwt | null =
    teamDomain && aud ? createAccessVerifier({ teamDomain, aud }) : null

  async function provisionOperator(email: string): Promise<UserRecord> {
    let user = await services.users.findByEmail(email)
    if (!user) {
      user = await services.users.create(email, {
        displayName: deriveOperatorName(email),
        role: "operator",
        emailVerified: true,
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
    const payload = await buildAdminSession(services, csrf, env, request, reply)
    reply.status(200).send(payload)
  })

  route(app, "adminLogout", { preHandler: csrfProtect, config: { rateLimit: ADMIN_AUTH_RATE_LIMIT } }, async (request, reply) => {
    const token = presentedSessionToken(request)
    if (token === null) {
      throw AppError.unauthorized()
    }
    const { userId, roles } = request.auth
    await services.sessions.revokeSession(token)
    clearSessionCookie(reply)
    clearCsrfCookie(reply)
    if (userId !== null && roles.includes("operator")) {
      await auditOperatorAuth(app, container, {
        actorId: userId,
        action: "operator.logout",
        target: `user:${userId}`,
        meta: { sessionRevoked: true },
      }).catch((err: unknown) => {
        request.log.warn({ err }, "operator.logout audit write failed")
      })
    }
    const payload: AdminLogoutResponse = { ok: true }
    reply.status(200).send(payload)
  })
}

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

async function establishOperatorSession(
  services: AuthServices,
  csrf: Csrf,
  request: FastifyRequest,
  reply: FastifyReply,
  user: UserRecord,
): Promise<AdminLoginResponse> {
  const accountStatus = await services.users.accountStatus(user.id)
  if (accountStatus === "banned") {
    throw AppError.forbidden("This account has been banned.")
  }
  if (accountStatus === "suspended") {
    throw AppError.forbidden(SUSPENDED_MESSAGE)
  }
  const token = await services.sessions.createSession(user.id, [user.role], {
    userAgent: request.headers["user-agent"] ?? null,
    ip: request.ip || null,
    accountStatus,
  })
  const ttl = services.sessions.ttl
  setSessionCookie(reply, token, ttl)
  const csrfToken = await csrf.tokenForSession(token)
  setCsrfCookie(reply, csrfToken, ttl)
  return { user: toUserPayload(user), csrfToken }
}

async function buildAdminSession(
  services: AuthServices,
  csrf: Csrf,
  env: Pick<Env, "ADMIN_EMAILS">,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<AdminSessionResponse> {
  const { auth } = request
  if (!auth.userId || !auth.roles.includes("operator")) {
    return { authenticated: false }
  }
  const user = await services.users.findById(auth.userId)
  if (!user || user.role !== "operator" || !isAdminEmail(env, user.email ?? "")) {
    return { authenticated: false }
  }

  const operator: AdminOperatorDTO = {
    id: user.id,
    name: user.displayName,
    email: user.email ?? "",
    role: user.role,
  }

  const sessionToken = presentedSessionToken(request)
  const token = sessionToken ? await csrf.tokenForSession(sessionToken) : generateCsrfToken()
  setCsrfCookie(reply, token, services.sessions.ttl)
  return { authenticated: true, operator, csrfToken: token }
}

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
    locale: resolveLocale(user.locale),
  }
}

function deriveOperatorName(email: string): string {
  const at = email.indexOf("@")
  const local = at > 0 ? email.slice(0, at) : email
  return local.length > 0 ? local : "Operator"
}
