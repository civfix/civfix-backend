/**
 * Admin inbox routes (catch-all inbound mail).
 *
 *   GET  /admin/inbox            the inbox list (filter status / recipient local-part / search) (InboxListResponse).
 *   GET  /admin/inbox/:id        one inbound email + body + attachment links (GetInboxMessageResponse).
 *   POST /admin/inbox/:id/status set the triage status (mark read / archive) (SetInboxStatusRequest). [csrf]
 *
 * The detail route presigns each attachment's R2 key into a time-limited GET URL (the DTO carries the
 * key field; on the wire it is a fetchable URL the admin reader links to). The requireOperator guard is
 * applied by routes/admin/index.ts (this router runs inside the guarded child context); the mutation
 * additionally carries csrfProtect. The repo is built lazily from the container (Drizzle inbound repo)
 * or from a per-instance test override.
 */

import {
  InboxListQuerySchema,
  SetInboxStatusRequestSchema,
  type AdminOkResponse,
  type InboundEmailDTO,
  type InboxListResponse,
} from "@civfix/shared"
import type { Storage } from "@civfix/shared/interfaces"
import { AppError } from "@civfix/shared"
import type { FastifyInstance } from "fastify"
import type { Container } from "../../di.js"
import { csrfProtect } from "../../auth/csrf.js"
import { route } from "../../versioning/route.js"
import { idParam, parse } from "./_route-utils.js"
import { MEDIA_GET_URL_TTL_SEC } from "../../services/media-intake-service.js"
import { mapWithLimit, PRESIGN_CONCURRENCY } from "../../services/media-presign.js"
import {
  makeDrizzleInboundRepository,
  type InboundRepository,
} from "../../services/admin/inbound-repository.drizzle.js"

/** Hard cap on attachments presigned per inbound email (defends a crafted mail with thousands of parts). */
const MAX_INBOX_ATTACHMENTS = 50

/**
 * Optional injected inbox dependencies (tests). When present the routes use the in-memory inbound repo +
 * a fake Storage instead of the container, so the HTTP flow runs offline with no DB and no R2.
 */
export interface AdminInboxRouteOverrides {
  repo: InboundRepository
  storage: Storage
}

declare module "fastify" {
  interface FastifyInstance {
    /** Injected admin-inbox route overrides (tests). See AdminInboxRouteOverrides. */
    adminInboxOverrides?: AdminInboxRouteOverrides
  }
}

export async function registerAdminInboxRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  function repo(): InboundRepository {
    return app.adminInboxOverrides?.repo ?? makeDrizzleInboundRepository(container.getDb().sql)
  }
  function storage(): Storage {
    return app.adminInboxOverrides?.storage ?? container.inboundStorage
  }

  // GET /admin/inbox
  route(app, "listInbox", async (request, reply) => {
    const query = parse(InboxListQuerySchema, request.query)
    const payload: InboxListResponse = await repo().list(query)
    reply.status(200).send(payload)
  })

  // GET /admin/inbox/:id  (presign attachment keys -> time-limited GET URLs)
  route(app, "getInboxMessage", async (request, reply) => {
    const { id } = idParam(request)
    const dto = await repo().get(id)
    if (dto === null) throw AppError.notFound("Inbound email not found.")
    const store = storage()
    const attachments = await mapWithLimit(
      dto.attachments.slice(0, MAX_INBOX_ATTACHMENTS),
      PRESIGN_CONCURRENCY,
      async (att) => ({ ...att, key: await store.presignGet(att.key, MEDIA_GET_URL_TTL_SEC) }),
    )
    const payload: InboundEmailDTO = { ...dto, attachments }
    reply.status(200).send(payload)
  })

  // POST /admin/inbox/:id/status  [csrf]
  route(app, "setInboxStatus", { preHandler: csrfProtect }, async (request, reply) => {
    const { id } = idParam(request)
    const body = parse(SetInboxStatusRequestSchema, { ...(request.body as object), id })
    const ok = await repo().setStatus(id, body.status)
    if (!ok) throw AppError.notFound("Inbound email not found.")
    const payload: AdminOkResponse = { ok: true }
    reply.status(200).send(payload)
  })
}
