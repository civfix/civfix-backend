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
  type GetModerationItemResponse,
  type ModerationListResponse,
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
  makeModerationService,
  type ModerationRepository,
} from "../../services/admin/moderation-service.js"
import { makeDrizzleModerationRepository } from "../../services/admin/moderation-repository.drizzle.js"
import { makeContainerReportChatEmitter } from "../../services/report-chat-emitter.js"
import type { ReportChatSystemEmitter } from "../../services/report-timeline-event.js"

/**
 * Optional injected moderation-service dependencies (tests). When present the routes build the service
 * from these (an in-memory repo) instead of the container, so the whole HTTP flow runs offline.
 */
export interface ModerationRouteOverrides {
  repo: ModerationRepository
  now?: () => Date
  /** D-D1: inject a fake timeline emitter in tests; the real path builds one from container primitives. */
  reportChatEmitter?: ReportChatSystemEmitter
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
  const csrfProtect = container.csrf.protect

  /** Build the moderation service from injected overrides (tests) or the container (production). */
  const service = overridableService(
    app,
    "moderationOverrides",
    (overrides) =>
      makeModerationService({
        repo: overrides.repo,
        ...spreadNow(overrides),
        ...(overrides.reportChatEmitter !== undefined
          ? { reportChatEmitter: overrides.reportChatEmitter }
          : {}),
      }),
    () => {
      const repo: ModerationRepository = makeDrizzleModerationRepository(container.getDb().sql)
      // D-D1: publish/remove of a REPORT subject mirrors into the report chat (best-effort, no-op
      // fake-chat).
      return makeModerationService({
        repo,
        reportChatEmitter: makeContainerReportChatEmitter(container, app.log),
      })
    },
  )

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
    const actorId = requireOperator(request)
    const { id, body } = parseBodyWithId(ApproveModerationRequestSchema, request)
    await service().approve(id, { actorId, note: body.note ?? null })
    sendOk(reply)
  })

  route(app, "removeModeration", { preHandler: csrfProtect }, async (request, reply) => {
    const actorId = requireOperator(request)
    const { id, body } = parseBodyWithId(RemoveModerationRequestSchema, request)
    await service().remove(id, { actorId, reason: body.reason ?? null })
    sendOk(reply)
  })

  route(app, "holdModeration", { preHandler: csrfProtect }, async (request, reply) => {
    const actorId = requireOperator(request)
    const { id, body } = parseBodyWithId(HoldModerationRequestSchema, request)
    await service().hold(id, { actorId, note: body.note ?? null })
    sendOk(reply)
  })

  route(app, "appealModeration", { preHandler: csrfProtect }, async (request, reply) => {
    const actorId = requireOperator(request)
    const { id, body } = parseBodyWithId(AppealModerationRequestSchema, request)
    await service().appeal(id, { decision: body.decision, actorId, note: body.note ?? null })
    sendOk(reply)
  })
}
