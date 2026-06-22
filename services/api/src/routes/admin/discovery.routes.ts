/**
 * Admin discovery (jurisdiction onboarding queue) routes: list / detail + the note / flag / draft
 * mutations. The acting operator's userId is recorded on every audit write.
 *
 * NOTES STORAGE: operator notes are persisted as audit_log rows (action discovery.note_added) and read
 * back from there - the discovery task has no notes column and the foundation schema is frozen. See
 * discovery-service.ts / discovery-repository.drizzle.ts.
 */

import {
  AddNoteRequestSchema,
  DiscoveryListQuerySchema,
  FlagDiscoveryRequestSchema,
  SaveDraftRequestSchema,
  type AdminOkResponse,
  type DiscoveryListResponse,
  type DiscoveryTaskDetailDTO,
  type ReportCategory,
} from "@civfix/shared"
import type { FastifyInstance } from "fastify"
import type { Container } from "../../di.js"
import { csrfProtect } from "../../auth/csrf.js"
import { route } from "../../versioning/route.js"
import { idParam, parse } from "./_route-utils.js"
import {
  makeDiscoveryService,
  type DiscoveryRepository,
  type DiscoveryService,
} from "../../services/admin/discovery-service.js"
import { makeDrizzleDiscoveryRepository } from "../../services/admin/discovery-repository.drizzle.js"

/**
 * Optional injected discovery-service dependencies (tests). When present the routes build the service
 * from these (an in-memory repo) instead of the container, so the whole HTTP flow runs offline.
 */
export interface DiscoveryRouteOverrides {
  repo: DiscoveryRepository
  now?: () => Date
}

declare module "fastify" {
  interface FastifyInstance {
    /** Injected discovery-route overrides (tests). See DiscoveryRouteOverrides. */
    discoveryOverrides?: DiscoveryRouteOverrides
  }
}

export async function registerAdminDiscoveryRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  /** Build the discovery service from injected overrides (tests) or the container (production). */
  function service(): DiscoveryService {
    const overrides = app.discoveryOverrides
    if (overrides) {
      return makeDiscoveryService({
        repo: overrides.repo,
        ...(overrides.now !== undefined ? { now: overrides.now } : {}),
      })
    }
    const repo: DiscoveryRepository = makeDrizzleDiscoveryRepository(container.getDb().sql)
    return makeDiscoveryService({ repo })
  }

  route(app, "listDiscovery", async (request, reply) => {
    const query = parse(DiscoveryListQuerySchema, request.query)
    const payload: DiscoveryListResponse = await service().list(query)
    reply.status(200).send(payload)
  })

  route(app, "getDiscoveryTask", async (request, reply) => {
    const { id } = idParam(request)
    const payload: DiscoveryTaskDetailDTO = await service().getTask(id)
    reply.status(200).send(payload)
  })

  route(app, "addDiscoveryNote", { preHandler: csrfProtect }, async (request, reply) => {
    const { id } = idParam(request)
    const body = parse(AddNoteRequestSchema, { ...(request.body as object), id })
    const actorId = request.auth.userId
    const who = await operatorLabel(app, actorId)
    // addNote persists the note AS the audit_log discovery.note_added row (the note store), so the write
    // is atomic + audited in one place; no separate writeAudit here.
    await service().addNote(id, { text: body.text, actorId, who })
    const payload: AdminOkResponse = { ok: true }
    reply.status(200).send(payload)
  })

  route(app, "flagDiscovery", { preHandler: csrfProtect }, async (request, reply) => {
    const { id } = idParam(request)
    const body = parse(FlagDiscoveryRequestSchema, { ...(request.body as object), id })
    await service().flag(id, { reason: body.reason ?? null, actorId: request.auth.userId })
    const payload: AdminOkResponse = { ok: true }
    reply.status(200).send(payload)
  })

  route(app, "saveDiscoveryDraft", { preHandler: csrfProtect }, async (request, reply) => {
    const { id } = idParam(request)
    const body = parse(SaveDraftRequestSchema, { ...(request.body as object), id })
    await service().saveDraft(id, {
      contacts: (body.contacts ?? {}) as Partial<Record<ReportCategory, string | null>>,
      defaultEmails: body.defaultEmails ?? [],
      formUrl: body.formUrl ?? null,
      actorId: request.auth.userId,
    })
    const payload: AdminOkResponse = { ok: true }
    reply.status(200).send(payload)
  })
}

/**
 * Resolve a human "who" label for an operator note from the operator's user record: @handle (the canonical
 * identifier), else display name, else email, else a short id. Falls back to "operator" when the auth
 * bundle / user is absent.
 */
async function operatorLabel(app: FastifyInstance, actorId: string | null): Promise<string> {
  if (actorId === null) return "operator"
  try {
    const user = await app.authServices.users.findById(actorId)
    if (!user) return "operator"
    return user.handle ?? user.displayName ?? user.email ?? actorId.slice(0, 8)
  } catch {
    return "operator"
  }
}
