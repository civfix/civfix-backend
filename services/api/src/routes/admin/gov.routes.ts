/**
 * Admin gov-provisioning routes (Phase 2).
 *
 *   GET  /admin/gov-claims          the provisioning queue (GovClaimListResponse).
 *   GET  /admin/gov-claims/:id      a claim detail (GetGovClaimResponse).
 *   POST /admin/gov-claims/:id/verify  set a verification check (VerifyCheckRequest). [csrf]
 *   POST /admin/gov-claims/:id/approve provision gov_admin + link jurisdiction (ApproveGovClaimRequest). [csrf]
 *   POST /admin/gov-claims/:id/reject  reject with reason (RejectGovClaimRequest). [csrf]
 *
 * Every body/query is validated against the shared Zod schema via parse(). The requireOperator guard is
 * applied by routes/admin/index.ts (this whole router runs inside the guarded child context); mutations
 * additionally carry csrfProtect. The acting operator's userId comes from request.auth.userId and is
 * recorded on every audit write (the repo writes the audit inside the same transaction as the effect).
 * The service is built lazily from the container (Drizzle repo + a UserProvisioner adapter over the
 * Phase 1 UserStore) or from a test override (in-memory repo + in-memory provisioner) for the offline
 * HTTP tests, mirroring the Phase 1 discovery routes.
 *
 * APPROVE provisions the gov user: find-or-create by the claim's contact_email, set role gov_admin, link
 * the jurisdiction (the approved claim row binds the user to its jurisdiction_geoid), status approved.
 */

import {
  AppError,
  ApproveGovClaimRequestSchema,
  GovClaimListQuerySchema,
  RejectGovClaimRequestSchema,
  VerifyCheckRequestSchema,
  type AdminOkResponse,
  type GetGovClaimResponse,
  type GovClaimListResponse,
} from "@civfix/shared"
import type { FastifyInstance } from "fastify"
import type { Container } from "../../di.js"
import { csrfProtect } from "../../auth/csrf.js"
import { route } from "../../versioning/route.js"
import { idParam, parse } from "./_route-utils.js"
import {
  makeGovClaimsService,
  type GovClaimsRepository,
  type GovClaimsService,
  type ProvisionedUser,
  type UserProvisioner,
} from "../../services/admin/gov-claims-service.js"
import { makeDrizzleGovClaimsRepository } from "../../services/admin/gov-claims-repository.drizzle.js"
import type { UserStore } from "../../auth/stores.js"

/**
 * Optional injected gov-claims-service dependencies (tests). When present the routes build the service
 * from these (an in-memory repo + provisioner) instead of the container, so the whole HTTP flow runs
 * offline.
 */
export interface GovClaimsRouteOverrides {
  repo: GovClaimsRepository
  users: UserProvisioner
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
 */
function provisionerFromUserStore(store: UserStore): UserProvisioner {
  return {
    async findByEmail(email: string): Promise<ProvisionedUser | null> {
      const user = await store.findByEmail(email)
      return user
        ? { id: user.id, email: user.email, role: user.role, emailVerified: user.emailVerified }
        : null
    },
    async create(email: string, displayName: string): Promise<ProvisionedUser> {
      const user = await store.create(email, { displayName, role: "gov_admin" })
      return { id: user.id, email: user.email, role: user.role, emailVerified: user.emailVerified }
    },
    async setRole(id: string, role: string): Promise<ProvisionedUser> {
      // The Phase 1 UserStore.setRole is typed to the Role union; the gov flow only ever passes
      // "gov_admin", which is a valid Role, so the cast is sound.
      const user = await store.setRole(id, role as Parameters<UserStore["setRole"]>[1])
      return { id: user.id, email: user.email, role: user.role, emailVerified: user.emailVerified }
    },
  }
}

export async function registerAdminGovRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  /** Build the gov-claims service from injected overrides (tests) or the container (production). */
  function service(): GovClaimsService {
    const overrides = app.govClaimsOverrides
    if (overrides) {
      return makeGovClaimsService({
        repo: overrides.repo,
        users: overrides.users,
        ...(overrides.now !== undefined ? { now: overrides.now } : {}),
      })
    }
    const repo: GovClaimsRepository = makeDrizzleGovClaimsRepository(container.getDb().sql)
    const store = app.authServices?.users
    if (!store) {
      // The auth bundle (and thus the UserStore) is only mounted when the Pg/Redis auth infra is present;
      // gov approve provisions a user, so it requires that bundle. A missing store is a server config
      // error, not a client error.
      throw AppError.internal("Auth services are not available for gov provisioning")
    }
    return makeGovClaimsService({ repo, users: provisionerFromUserStore(store) })
  }

  // -------------------------------------------------------------------------
  // GET /admin/gov-claims
  // -------------------------------------------------------------------------
  route(app, "listGovClaims", async (request, reply) => {
    const query = parse(GovClaimListQuerySchema, request.query)
    const payload: GovClaimListResponse = await service().list(query)
    reply.status(200).send(payload)
  })

  // -------------------------------------------------------------------------
  // GET /admin/gov-claims/:id
  // -------------------------------------------------------------------------
  route(app, "getGovClaim", async (request, reply) => {
    const { id } = idParam(request)
    const payload: GetGovClaimResponse = await service().getClaim(id)
    reply.status(200).send(payload)
  })

  // -------------------------------------------------------------------------
  // POST /admin/gov-claims/:id/verify  [csrf]
  // -------------------------------------------------------------------------
  route(app, "verifyGovClaim", { preHandler: csrfProtect }, async (request, reply) => {
    const { id } = idParam(request)
    const body = parse(VerifyCheckRequestSchema, { ...(request.body as object), id })
    await service().verify(id, {
      check: body.check,
      status: body.status,
      evidence: body.evidence ?? null,
      note: body.note ?? null,
      actorId: request.auth.userId,
    })
    const payload: AdminOkResponse = { ok: true }
    reply.status(200).send(payload)
  })

  // -------------------------------------------------------------------------
  // POST /admin/gov-claims/:id/approve  [csrf]
  // -------------------------------------------------------------------------
  route(app, "approveGovClaim", { preHandler: csrfProtect }, async (request, reply) => {
    const { id } = idParam(request)
    const body = parse(ApproveGovClaimRequestSchema, { ...(request.body as object), id })
    await service().approve(id, { actorId: request.auth.userId, note: body.note ?? null })
    const payload: AdminOkResponse = { ok: true }
    reply.status(200).send(payload)
  })

  // -------------------------------------------------------------------------
  // POST /admin/gov-claims/:id/reject  [csrf]
  // -------------------------------------------------------------------------
  route(app, "rejectGovClaim", { preHandler: csrfProtect }, async (request, reply) => {
    const { id } = idParam(request)
    const body = parse(RejectGovClaimRequestSchema, { ...(request.body as object), id })
    await service().reject(id, { reason: body.reason, actorId: request.auth.userId })
    const payload: AdminOkResponse = { ok: true }
    reply.status(200).send(payload)
  })
}
