import {
  ApproveGovClaimRequestSchema,
  GovClaimListQuerySchema,
  RejectGovClaimRequestSchema,
  VerifyCheckRequestSchema,
  type GetGovClaimResponse,
  type GovClaimListResponse,
  type Role,
} from "@civfix/shared"
import type { FastifyInstance } from "fastify"
import type { Container } from "../../di.js"
import { requireOperator } from "../../auth/admin-guard.js"
import { route } from "../../versioning/route.js"
import {
  idParam,
  overridableService,
  parse,
  parseBodyWithId,
  sendOk,
  spreadNow,
} from "./_route-utils.js"
import {
  makeGovClaimsService,
  type ProvisionedUser,
  type UserProvisioner,
} from "../../services/admin/gov-claims-service.js"
import type { GovClaimsRepository } from "../../services/admin/gov-claims-repository.js"
import { makeDrizzleGovClaimsRepository } from "../../services/admin/gov-claims-repository.drizzle.js"
import type { RevokeAllSessions } from "../../services/admin/role-change.js"
import type { UserRecord, UserStore } from "../../auth/stores.js"

export interface GovClaimsRouteOverrides {
  repo: GovClaimsRepository
  users: UserProvisioner
  revokeSessions?: RevokeAllSessions
  now?: () => Date
}

declare module "fastify" {
  interface FastifyInstance {
    govClaimsOverrides?: GovClaimsRouteOverrides
  }
}

function toProvisionedUser(user: UserRecord): ProvisionedUser {
  return { id: user.id, email: user.email, role: user.role, emailVerified: user.emailVerified }
}

function provisionerFromUserStore(store: UserStore): UserProvisioner {
  const norm = (email: string): string => email.trim().toLowerCase()
  return {
    async findByEmail(email: string): Promise<ProvisionedUser | null> {
      const user = await store.findByEmail(norm(email))
      return user ? toProvisionedUser(user) : null
    },
    async create(email: string, displayName: string): Promise<ProvisionedUser> {
      return toProvisionedUser(await store.create(norm(email), { displayName, role: "citizen" }))
    },
    async setRole(id: string, role: Role): Promise<ProvisionedUser> {
      return toProvisionedUser(await store.setRole(id, role))
    },
  }
}

export async function registerAdminGovRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  const csrfProtect = container.csrf.protect

  const revokeSessions: RevokeAllSessions = (userId) =>
    app.authServices.sessions.revokeAllForUser(userId)

  const service = overridableService(
    app,
    "govClaimsOverrides",
    (overrides) =>
      makeGovClaimsService({
        repo: overrides.repo,
        users: overrides.users,
        revokeSessions: overrides.revokeSessions ?? revokeSessions,
        ...spreadNow(overrides),
      }),
    () => {
      const repo: GovClaimsRepository = makeDrizzleGovClaimsRepository(container.getDb().sql)
      return makeGovClaimsService({
        repo,
        users: provisionerFromUserStore(app.authServices.users),
        revokeSessions,
      })
    },
  )

  route(app, "listGovClaims", async (request, reply) => {
    const query = parse(GovClaimListQuerySchema, request.query)
    const payload: GovClaimListResponse = await service().list(query)
    reply.status(200).send(payload)
  })

  route(app, "getGovClaim", async (request, reply) => {
    const { id } = idParam(request)
    const payload: GetGovClaimResponse = await service().getClaim(id)
    reply.status(200).send(payload)
  })

  route(app, "verifyGovClaim", { preHandler: csrfProtect }, async (request, reply) => {
    const actorId = requireOperator(request)
    const { id, body } = parseBodyWithId(VerifyCheckRequestSchema, request)
    await service().verify(id, {
      check: body.check,
      status: body.status,
      evidence: body.evidence ?? null,
      note: body.note ?? null,
      actorId,
    })
    sendOk(reply)
  })

  route(app, "approveGovClaim", { preHandler: csrfProtect }, async (request, reply) => {
    const actorId = requireOperator(request)
    const { id, body } = parseBodyWithId(ApproveGovClaimRequestSchema, request)
    await service().approve(id, { actorId, note: body.note ?? null })
    sendOk(reply)
  })

  route(app, "rejectGovClaim", { preHandler: csrfProtect }, async (request, reply) => {
    const actorId = requireOperator(request)
    const { id, body } = parseBodyWithId(RejectGovClaimRequestSchema, request)
    await service().reject(id, { reason: body.reason, actorId })
    sendOk(reply)
  })
}
