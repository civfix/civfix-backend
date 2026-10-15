import { AppError } from "@civfix/shared"
import type { AuthContext } from "@civfix/shared"
import type { FastifyInstance, FastifyRequest } from "fastify"
import { verifyAnonTokenSignature } from "../abuse/anon-token.js"
import type { AuthServices } from "./auth-services.js"
import type { AccountStatus } from "./stores.js"
import { ANON_COOKIE, presentedSessionToken } from "./transport.js"

// A signed-in browser can still carry the verified anon cookie it held as a guest. That id names only
// the uploads the browser made before signing in; quota, report identity and every other check stay on
// the account, which is why it is not the anonymous subject.
export interface RequestAuthContext extends AuthContext {
  guestAnonSessionId?: string
}

declare module "fastify" {
  interface FastifyRequest {
    auth: RequestAuthContext
    sessionExpiresAtMs?: number
    accountStatus?: AccountStatus
  }
  interface FastifyInstance {
    authServices: AuthServices
  }
}

function anonymousAuth(anonSessionId?: string): AuthContext {
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

// Only a cookie carrying our HMAC names an anonymous subject. An unsigned or forged value is treated as
// no cookie at all (never a rejected request), so callers cannot mint arbitrary quota keys with it.
function verifiedAnonSessionId(request: FastifyRequest): string | undefined {
  const anonCookie = request.cookies?.[ANON_COOKIE]
  if (!anonCookie) return undefined
  const signingKey = request.server.container.env.ANON_TOKEN_SIGNING_KEY
  return verifyAnonTokenSignature(anonCookie, signingKey) ?? undefined
}

export async function resolveAuthContext(request: FastifyRequest): Promise<RequestAuthContext> {
  const services: AuthServices | undefined = request.server.authServices
  const token = presentedSessionToken(request)
  if (services && token) {
    const resolved = await services.sessions.resolveSession(token)
    if (resolved) {
      request.sessionExpiresAtMs = resolved.expiresAtMs
      request.accountStatus = resolved.accountStatus
      const guestAnonSessionId = verifiedAnonSessionId(request)
      return {
        userId: resolved.userId,
        roles: resolved.roles,
        anon: false,
        ...(guestAnonSessionId !== undefined ? { guestAnonSessionId } : {}),
      }
    }
  }
  return anonymousAuth(verifiedAnonSessionId(request))
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
