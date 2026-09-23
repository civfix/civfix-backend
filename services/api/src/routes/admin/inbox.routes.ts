// The requireOperator guard is applied by routes/admin/index.ts: this router runs inside the guarded
// child context. On the wire an attachment's `key` field carries a time-limited presigned GET URL, never
// the raw R2 key.

import {
  InboxListQuerySchema,
  SetInboxStatusRequestSchema,
  type InboundEmailDTO,
  type InboxListResponse,
} from "@civfix/shared"
import type { Storage } from "@civfix/shared/interfaces"
import { AppError } from "@civfix/shared"
import type { FastifyInstance } from "fastify"
import type { Container } from "../../di.js"
import { route } from "../../versioning/route.js"
import { idParam, parse, parseBodyWithId, sendOk } from "./_route-utils.js"
import { auditRead } from "./_audit-read.js"
import { requireOperator } from "../../auth/admin-guard.js"
import { MEDIA_GET_URL_TTL_SEC } from "../../services/media-intake-service.js"
import { mapWithLimit, PRESIGN_CONCURRENCY } from "../../services/media-presign.js"
import {
  makeDrizzleInboundRepository,
  type InboundRepository,
} from "../../services/admin/inbound-repository.drizzle.js"

/** Defends against a crafted mail with thousands of parts. */
const MAX_INBOX_ATTACHMENTS = 50

const INBOUND_EMAIL_NOT_FOUND = "Inbound email not found."

/** Test-only: an in-memory repo and a fake Storage so the HTTP flow runs offline with no DB and no R2. */
export interface AdminInboxRouteOverrides {
  repo: InboundRepository
  storage: Storage
}

declare module "fastify" {
  interface FastifyInstance {
    adminInboxOverrides?: AdminInboxRouteOverrides
  }
}

export async function registerAdminInboxRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  const csrfProtect = container.csrf.protect

  function repo(): InboundRepository {
    return app.adminInboxOverrides?.repo ?? makeDrizzleInboundRepository(container.getDb().sql)
  }
  function storage(): Storage {
    return app.adminInboxOverrides?.storage ?? container.inboundStorage
  }

  route(app, "listInbox", async (request, reply) => {
    const query = parse(InboxListQuerySchema, request.query)
    const payload: InboxListResponse = await repo().list(query)
    reply.status(200).send(payload)
  })

  // A per-subject read (one citizen<->city email with its full body and fetchable attachments), audited
  // best-effort so the disclosure is attributable.
  route(app, "getInboxMessage", async (request, reply) => {
    const { id } = idParam(request)
    const dto = await repo().get(id)
    if (dto === null) throw AppError.notFound(INBOUND_EMAIL_NOT_FOUND)
    await auditRead(request, container, requireOperator(request), {
      action: "inbox.message_viewed",
      target: `inbound_email:${id}`,
      meta: { attachments: dto.attachments.length },
    })
    // Over the cap the extra parts are dropped with no wire signal (the DTO has no truncation flag), so
    // the omission is recorded here and in the audit meta above; otherwise nobody could tell evidence was
    // left out.
    if (dto.attachments.length > MAX_INBOX_ATTACHMENTS) {
      request.log.warn(
        { inboundEmailId: id, attachments: dto.attachments.length, cap: MAX_INBOX_ATTACHMENTS },
        "inbound email attachments truncated for presigning",
      )
    }
    const store = storage()
    const attachments = await mapWithLimit(
      dto.attachments.slice(0, MAX_INBOX_ATTACHMENTS),
      PRESIGN_CONCURRENCY,
      async (att) => ({ ...att, key: await store.presignGet(att.key, MEDIA_GET_URL_TTL_SEC) }),
    )
    const payload: InboundEmailDTO = { ...dto, attachments }
    reply.status(200).send(payload)
  })

  // The repo writes the inbox.status_changed audit row in the same transaction as the UPDATE.
  route(app, "setInboxStatus", { preHandler: csrfProtect }, async (request, reply) => {
    const operatorId = requireOperator(request)
    const { id, body } = parseBodyWithId(SetInboxStatusRequestSchema, request)
    const ok = await repo().setStatus(id, body.status, operatorId)
    if (!ok) throw AppError.notFound(INBOUND_EMAIL_NOT_FOUND)
    sendOk(reply)
  })
}
