// The discovery task has no notes column, so operator notes are stored and read back as audit_log rows
// (action discovery.note_added); see discovery-repository.drizzle.ts.

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

const FALLBACK_OPERATOR_LABEL = "operator"
const ACTOR_ID_LABEL_CHARS = 8

/** Test-only: an in-memory repo so the whole HTTP flow runs offline. */
export interface DiscoveryRouteOverrides {
  repo: DiscoveryRepository
  now?: () => Date
}

declare module "fastify" {
  interface FastifyInstance {
    discoveryOverrides?: DiscoveryRouteOverrides
  }
}

export async function registerAdminDiscoveryRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  const csrfProtect = container.csrf.protect

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
    // The note IS its audit_log row, so there is no separate writeAudit here.
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
      // The shared `.url()` schema lets javascript:/data: URIs through.
      formUrl: httpUrlField(body.formUrl, "formUrl"),
      actorId,
    })
    sendOk(reply)
  })
}

/** The @handle leads because it is the operator's canonical identifier. */
async function operatorLabel(app: FastifyInstance, actorId: string): Promise<string> {
  try {
    const user = await app.authServices.users.findById(actorId)
    if (!user) return FALLBACK_OPERATOR_LABEL
    return user.handle ?? user.displayName ?? user.email ?? actorId.slice(0, ACTOR_ID_LABEL_CHARS)
  } catch {
    return FALLBACK_OPERATOR_LABEL
  }
}
