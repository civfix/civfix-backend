import { AppError } from "@civfix/shared"
import type { AuthContext } from "@civfix/shared"
import type { FastifyInstance, FastifyRequest } from "fastify"
import type { AuthServices } from "./auth-services.js"
import type { AccountStatus } from "./stores.js"
import { ANON_COOKIE, presentedSessionToken } from "./transport.js"

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthContext
    sessionExpiresAtMs?: number
    accountStatus?: AccountStatus
  }
  interface FastifyInstance {
    authServices: AuthServices
  }
}

export function anonymousAuth(anonSessionId?: string): AuthContext {
  return {
    userId: null,
    roles: [],
    anon: true,
    ...(anonSessionId !== undefined ? { anonSessionId } : {}),
  }
}

export async function registerAuthContext(app: FastifyInstance): Promise<void> {
  app.decorateRequest("auth")

  app.addHook("onRequest", async (request: FastifyRequest) => {
    request.auth = await resolveAuthContext(request)
  })
}

export async function resolveAuthContext(request: FastifyRequest): Promise<AuthContext> {
  const anonCookie = request.cookies?.[ANON_COOKIE]

  const services: AuthServices | undefined = request.server.authServices
  const token = presentedSessionToken(request)
  if (services && token) {
    const resolved = await services.sessions.resolveSession(token)
    if (resolved) {
      request.sessionExpiresAtMs = resolved.expiresAtMs
      request.accountStatus = resolved.accountStatus
      return { userId: resolved.userId, roles: resolved.roles, anon: false }
    }
  }
  return anonymousAuth(anonCookie)
}

export function requireAuth(request: FastifyRequest): string {
  const userId = request.auth?.userId
  if (!userId) {
    throw AppError.unauthorized()
  }
  return userId
}

export function requireRole(request: FastifyRequest, ...roles: AuthContext["roles"]): void {
  const held = request.auth?.roles ?? []
  if (!roles.some((r) => held.includes(r))) {
    throw AppError.forbidden()
  }
}
