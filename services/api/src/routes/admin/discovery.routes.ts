/**
 * Admin discovery (jurisdiction onboarding queue) routes (Phase 2).
 *
 *   GET  /admin/discovery            the population-sorted discovery queue (DiscoveryListResponse).
 *   GET  /admin/discovery/:id        a discovery task detail (GetDiscoveryTaskResponse).
 *   POST /admin/discovery/:id/notes  add an operator note (AddNoteRequest). [csrf]
 *   POST /admin/discovery/:id/flag   flag the task for review (FlagDiscoveryRequest). [csrf]
 *   POST /admin/discovery/:id/draft  save contact drafts without routing (SaveDraftRequest). [csrf]
 *
 * Every body/query is validated against the shared Zod schema via parse(). The requireOperator guard is
 * applied by routes/admin/index.ts (this whole router runs inside the guarded child context); mutations
 * additionally carry csrfProtect. The acting operator's userId comes from request.auth.userId and is
 * recorded on every audit write. The service is built lazily from the container (Drizzle repo) or from a
 * test override (in-memory repo) for the offline HTTP tests, mirroring the Phase 1 reports routes.
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

  // -------------------------------------------------------------------------
  // GET /admin/discovery
  // -------------------------------------------------------------------------
  route(app, "listDiscovery", async (request, reply) => {
    const query = parse(DiscoveryListQuerySchema, request.query)
    const payload: DiscoveryListResponse = await service().list(query)
    reply.status(200).send(payload)
  })

  // -------------------------------------------------------------------------
  // GET /admin/discovery/:id
  // -------------------------------------------------------------------------
  route(app, "getDiscoveryTask", async (request, reply) => {
    const { id } = idParam(request)
    const payload: DiscoveryTaskDetailDTO = await service().getTask(id)
    reply.status(200).send(payload)
  })

  // -------------------------------------------------------------------------
  // POST /admin/discovery/:id/notes  [csrf]
  // -------------------------------------------------------------------------
  route(app, "addDiscoveryNote", { preHandler: csrfProtect }, async (request, reply) => {
    const { id } = idParam(request)
    const body = parse(AddNoteRequestSchema, { ...(request.body as object), id })
    const actorId = request.auth.userId
    const who = await operatorLabel(app, actorId)
    // addNote persists the note AS the audit_log discovery.note_added row (the note store), so the write
    // is atomic + audited in one place; no separate writeAudit here. Return the mutation ack.
    await service().addNote(id, { text: body.text, actorId, who })
    const payload: AdminOkResponse = { ok: true }
    reply.status(200).send(payload)
  })

  // -------------------------------------------------------------------------
  // POST /admin/discovery/:id/flag  [csrf]
  // -------------------------------------------------------------------------
  route(app, "flagDiscovery", { preHandler: csrfProtect }, async (request, reply) => {
    const { id } = idParam(request)
    const body = parse(FlagDiscoveryRequestSchema, { ...(request.body as object), id })
    await service().flag(id, { reason: body.reason ?? null, actorId: request.auth.userId })
    const payload: AdminOkResponse = { ok: true }
    reply.status(200).send(payload)
  })

  // -------------------------------------------------------------------------
  // POST /admin/discovery/:id/draft  [csrf]
  // -------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a human "who" label for an operator note from the operator's user record (display name, else
 * handle, else email, else a short id). Falls back to "operator" when the auth bundle / user is absent.
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
