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
  type DiscoveryListResponse,
  type DiscoveryTaskDetailDTO,
  type ReportCategory,
} from "@civfix/shared"
import type { FastifyInstance } from "fastify"
import type { Container } from "../../di.js"
import { requireOperator } from "../../auth/admin-guard.js"
import { route } from "../../versioning/route.js"
import {
  httpUrlField,
  idParam,
  overridableService,
  parse,
  parseBodyWithId,
  sendOk,
  spreadNow,
} from "./_route-utils.js"
import {
  makeDiscoveryService,
  type DiscoveryRepository,
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
  const csrfProtect = container.csrf.protect

  /** Build the discovery service from injected overrides (tests) or the container (production). */
  const service = overridableService(
    app,
    "discoveryOverrides",
    (overrides) => makeDiscoveryService({ repo: overrides.repo, ...spreadNow(overrides) }),
    () => {
      const repo: DiscoveryRepository = makeDrizzleDiscoveryRepository(container.getDb().sql)
      return makeDiscoveryService({ repo })
    },
  )

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
    const actorId = requireOperator(request)
    const { id, body } = parseBodyWithId(AddNoteRequestSchema, request)
    const who = await operatorLabel(app, actorId)
    // addNote persists the note AS the audit_log discovery.note_added row (the note store), so the write
    // is atomic + audited in one place; no separate writeAudit here.
    await service().addNote(id, { text: body.text, actorId, who })
    sendOk(reply)
  })

  route(app, "flagDiscovery", { preHandler: csrfProtect }, async (request, reply) => {
    const actorId = requireOperator(request)
    const { id, body } = parseBodyWithId(FlagDiscoveryRequestSchema, request)
    await service().flag(id, { reason: body.reason ?? null, actorId })
    sendOk(reply)
  })

  route(app, "saveDiscoveryDraft", { preHandler: csrfProtect }, async (request, reply) => {
    const actorId = requireOperator(request)
    const { id, body } = parseBodyWithId(SaveDraftRequestSchema, request)
    await service().saveDraft(id, {
      contacts: (body.contacts ?? {}) as Partial<Record<ReportCategory, string | null>>,
      defaultEmails: body.defaultEmails ?? [],
      // L7: reject javascript:/data: URIs the shared `.url()` schema lets through (see httpUrlField).
      formUrl: httpUrlField(body.formUrl, "formUrl"),
      actorId,
    })
    sendOk(reply)
  })
}

/**
 * Resolve a human "who" label for an operator note from the operator's user record: @handle (the canonical
 * identifier), else display name, else email, else a short id. Falls back to "operator" when the user
 * record cannot be read.
 */
async function operatorLabel(app: FastifyInstance, actorId: string): Promise<string> {
  try {
    const user = await app.authServices.users.findById(actorId)
    if (!user) return "operator"
    return user.handle ?? user.displayName ?? user.email ?? actorId.slice(0, 8)
  } catch {
    return "operator"
  }
}
