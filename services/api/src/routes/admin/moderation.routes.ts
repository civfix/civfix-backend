/**
 * Admin moderation queue routes (Phase 2).
 *
 *   GET  /admin/moderation          the moderation queue (ModerationListResponse).
 *   GET  /admin/moderation/:id      an item detail with signals/user/similar (GetModerationItemResponse).
 *   POST /admin/moderation/:id/approve  approve (publish the subject) (ApproveModerationRequest). [csrf]
 *   POST /admin/moderation/:id/remove   remove (reject the subject) (RemoveModerationRequest). [csrf]
 *   POST /admin/moderation/:id/hold     hold for further review (HoldModerationRequest). [csrf]
 *   POST /admin/moderation/:id/appeal   decide an appeal uphold|overturn (AppealModerationRequest). [csrf]
 *
 * Every body/query is validated against the shared Zod schema via parse(). The requireOperator guard is
 * applied by routes/admin/index.ts (this whole router runs inside the guarded child context); mutations
 * additionally carry csrfProtect and resolve the acting operator's (non-null) userId via
 * requireOperator(request), recorded on every audit write (the repo writes the audit inside the same
 * transaction as the effect).
 * The service is built lazily from the container (Drizzle repo) or from a test override (in-memory repo)
 * for the offline HTTP tests, mirroring the Phase 1 discovery routes.
 *
 * The actions transition the item AND apply the underlying effect (approve -> publish the held report;
 * remove -> reject it; hold -> extend the hold; appeal -> uphold/overturn a chat suspension) and the
 * item clears from the queue on any action (status <> 'open'). See moderation-service.ts.
 */

import {
  ApproveModerationRequestSchema,
  AppealModerationRequestSchema,
  HoldModerationRequestSchema,
  ModerationListQuerySchema,
  RemoveModerationRequestSchema,
  type AdminOkResponse,
  type GetModerationItemResponse,
  type ModerationListResponse,
} from "@civfix/shared"
import type { FastifyInstance } from "fastify"
import type { Container } from "../../di.js"
import { csrfProtect } from "../../auth/csrf.js"
import { requireOperator } from "../../auth/admin-guard.js"
import { route } from "../../versioning/route.js"
import { idParam, parse } from "./_route-utils.js"
import {
  makeModerationService,
  type ModerationRepository,
  type ModerationService,
} from "../../services/admin/moderation-service.js"
import { makeDrizzleModerationRepository } from "../../services/admin/moderation-repository.drizzle.js"

/**
 * Optional injected moderation-service dependencies (tests). When present the routes build the service
 * from these (an in-memory repo) instead of the container, so the whole HTTP flow runs offline.
 */
export interface ModerationRouteOverrides {
  repo: ModerationRepository
  now?: () => Date
}

declare module "fastify" {
  interface FastifyInstance {
    /** Injected moderation-route overrides (tests). See ModerationRouteOverrides. */
    moderationOverrides?: ModerationRouteOverrides
  }
}

export async function registerAdminModerationRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  /** Build the moderation service from injected overrides (tests) or the container (production). */
  function service(): ModerationService {
    const overrides = app.moderationOverrides
    if (overrides) {
      return makeModerationService({
        repo: overrides.repo,
        ...(overrides.now !== undefined ? { now: overrides.now } : {}),
      })
    }
    const repo: ModerationRepository = makeDrizzleModerationRepository(container.getDb().sql)
    return makeModerationService({ repo })
  }

  route(app, "listModeration", async (request, reply) => {
    const query = parse(ModerationListQuerySchema, request.query)
    const payload: ModerationListResponse = await service().list(query)
    reply.status(200).send(payload)
  })

  route(app, "getModerationItem", async (request, reply) => {
    const { id } = idParam(request)
    const payload: GetModerationItemResponse = await service().getItem(id)
    reply.status(200).send(payload)
  })

  route(app, "approveModeration", { preHandler: csrfProtect }, async (request, reply) => {
    const { id } = idParam(request)
    const body = parse(ApproveModerationRequestSchema, { ...(request.body as object), id })
    await service().approve(id, { actorId: requireOperator(request), note: body.note ?? null })
    const payload: AdminOkResponse = { ok: true }
    reply.status(200).send(payload)
  })

  route(app, "removeModeration", { preHandler: csrfProtect }, async (request, reply) => {
    const { id } = idParam(request)
    const body = parse(RemoveModerationRequestSchema, { ...(request.body as object), id })
    await service().remove(id, { actorId: requireOperator(request), reason: body.reason ?? null })
    const payload: AdminOkResponse = { ok: true }
    reply.status(200).send(payload)
  })

  route(app, "holdModeration", { preHandler: csrfProtect }, async (request, reply) => {
    const { id } = idParam(request)
    const body = parse(HoldModerationRequestSchema, { ...(request.body as object), id })
    await service().hold(id, { actorId: requireOperator(request), note: body.note ?? null })
    const payload: AdminOkResponse = { ok: true }
    reply.status(200).send(payload)
  })

  route(app, "appealModeration", { preHandler: csrfProtect }, async (request, reply) => {
    const { id } = idParam(request)
    const body = parse(AppealModerationRequestSchema, { ...(request.body as object), id })
    await service().appeal(id, {
      decision: body.decision,
      actorId: requireOperator(request),
      note: body.note ?? null,
    })
    const payload: AdminOkResponse = { ok: true }
    reply.status(200).send(payload)
  })
}
