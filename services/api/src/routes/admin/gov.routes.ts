/**
 * Admin gov-provisioning routes: the provisioning queue + verify/approve/reject. APPROVE provisions the
 * gov user (find-or-create by the claim's contact_email, set role gov_admin, link the jurisdiction via the
 * approved claim row), all audited in-tx by the repo. The service is built lazily from the container
 * (Drizzle repo + a UserProvisioner adapter over the Phase 1 UserStore) or a test override.
 */

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
  type GovClaimsRepository,
  type ProvisionedUser,
  type UserProvisioner,
} from "../../services/admin/gov-claims-service.js"
import { makeDrizzleGovClaimsRepository } from "../../services/admin/gov-claims-repository.drizzle.js"
import type { RevokeAllSessions } from "../../services/admin/role-change.js"
import type { UserStore } from "../../auth/stores.js"

/**
 * Optional injected gov-claims-service dependencies (tests). When present the routes build the service
 * from these (an in-memory repo + provisioner) instead of the container, so the whole HTTP flow runs
 * offline.
 */
export interface GovClaimsRouteOverrides {
  repo: GovClaimsRepository
  users: UserProvisioner
  /** M4: session-revoke seam (a spy in tests). Defaults to the real SessionService when omitted. */
  revokeSessions?: RevokeAllSessions
  now?: () => Date
}

declare module "fastify" {
  interface FastifyInstance {
    /** Injected gov-claims-route overrides (tests). See GovClaimsRouteOverrides. */
    govClaimsOverrides?: GovClaimsRouteOverrides
  }
}

/**
 * Adapt the Phase 1 UserStore into the narrow UserProvisioner seam the gov approve flow needs (find-or-
 * create by email + idempotent setRole). The new gov user is created with a placeholder displayName (the
 * applicant name from the claim) and an UNverified email - they verify by signing in with Email-OTP
 * later; the account merely needs the role + the address so a later sign-in converges on it.
 *
 * Email is lowercased/trimmed before find-or-create so it converges on the SAME row a later Email-OTP
 * sign-in (which lowercases the verified address) lands on - a mixed-case claim contact_email must not
 * fork a distinct account from the one the applicant signs into.
 */
function provisionerFromUserStore(store: UserStore): UserProvisioner {
  const norm = (email: string): string => email.trim().toLowerCase()
  return {
    async findByEmail(email: string): Promise<ProvisionedUser | null> {
      const user = await store.findByEmail(norm(email))
      return user
        ? { id: user.id, email: user.email, role: user.role, emailVerified: user.emailVerified }
        : null
    },
    async create(email: string, displayName: string): Promise<ProvisionedUser> {
      const user = await store.create(norm(email), { displayName, role: "gov_admin" })
      return { id: user.id, email: user.email, role: user.role, emailVerified: user.emailVerified }
    },
    async setRole(id: string, role: Role): Promise<ProvisionedUser> {
      const user = await store.setRole(id, role)
      return { id: user.id, email: user.email, role: user.role, emailVerified: user.emailVerified }
    },
  }
}

export async function registerAdminGovRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  const csrfProtect = container.csrf.protect

  /**
   * M4: the session-revoke a role change requires. Wired to SessionService.revokeAllForUser, the same seam
   * the admin users router uses — approving a gov claim can demote a live OPERATOR, and the operator role
   * would otherwise stay warm in Redis until session expiry (which sliding expiry defers indefinitely).
   *
   * The auth bundle is read unguarded, like the sibling users/auth routers: server.ts mounts /admin/*
   * only when it exists, and without it requireOperatorPreHandler already fails closed before any handler.
   */
  const revokeSessions: RevokeAllSessions = (userId) =>
    app.authServices.sessions.revokeAllForUser(userId)

  /** Build the gov-claims service from injected overrides (tests) or the container (production). */
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
