import {
  DownloadHostExportRequestSchema,
  GetEventExportRequestSchema,
  ListEventExportsRequestSchema,
  RequestEventExportRequestSchema,
  type DownloadHostExportResponse,
  type HostExportDTO,
  type ListEventExportsResponse,
} from "@civfix/shared"
import { AppError } from "@civfix/shared"
import type { FastifyInstance } from "fastify"
import type { Container } from "../../di.js"
import { requireAuth } from "../../auth/context.js"
import { perIdentity } from "../../plugins/rate-limit.js"
import { route } from "../../versioning/route.js"
import { parse, paramsOverBody, paramsOverQuery } from "../_validate.js"
import { requireCapability } from "../../services/host/authz.js"
import { HOST_EXPORT_JOB } from "../../lib/queue-names.js"
import { makeCommsRuntime } from "../../services/host/comms-wiring.js"
import type { CommsRuntime } from "../../services/host/comms-wiring.js"
import {
  EXPORT_NOT_FOUND,
  toHostExportDTO,
  type HostExportService,
} from "../../services/host/export-service.js"

export const EXPORT_REQUEST_RATE_LIMIT = perIdentity({ max: 10, timeWindow: "1 hour" })
export const EXPORT_READ_RATE_LIMIT = perIdentity({ max: 60, timeWindow: "1 minute" })
export const EXPORT_DOWNLOAD_RATE_LIMIT = perIdentity({ max: 30, timeWindow: "1 minute" })

const EXPORT_JOB_RETRY_LIMIT = 2
const EXPORT_AUDIT_ACTION = "event.roster_exported"

export interface HostExportOverrides {
  exports: HostExportService
}

declare module "fastify" {
  interface FastifyInstance {
    hostExportOverrides?: HostExportOverrides
  }
}

export async function registerHostExportRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  const csrfProtect = container.csrf.protect
  let cached: CommsRuntime | undefined

  function exports(): HostExportService {
    const override = app.hostExportOverrides
    if (override) return override.exports
    return (cached ??= makeCommsRuntime(container, app.log)).exports
  }

  route(
    app,
    "requestEventExport",
    { preHandler: csrfProtect, config: { rateLimit: EXPORT_REQUEST_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const body = parse(RequestEventExportRequestSchema, paramsOverBody(request))
      await requireCapability(container.getDb().sql, body.id, userId, "export")
      const payload: HostExportDTO = await exports().request({
        cleanupId: body.id,
        organizationId: null,
        requestedBy: userId,
        kind: body.kind,
        filters: body.filters,
        audit: (exportId) => ({
          action: EXPORT_AUDIT_ACTION,
          actorId: userId,
          target: `cleanup:${body.id}`,
          meta: { exportId, kind: body.kind },
        }),
      })
      await container.jobs.enqueue(
        HOST_EXPORT_JOB,
        { exportId: payload.id },
        { singletonKey: `export:${payload.id}`, retryLimit: EXPORT_JOB_RETRY_LIMIT },
      )
      reply.status(200).send(payload)
    },
  )

  route(
    app,
    "listEventExports",
    { config: { rateLimit: EXPORT_READ_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const query = parse(ListEventExportsRequestSchema, paramsOverQuery(request))
      await requireCapability(container.getDb().sql, query.id, userId, "export")
      const items = await exports().listForEvent(query.id)
      const payload: ListEventExportsResponse = { items, nextCursor: null }
      reply.status(200).send(payload)
    },
  )

  route(
    app,
    "getEventExport",
    { config: { rateLimit: EXPORT_READ_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const params = parse(GetEventExportRequestSchema, paramsOverBody(request))
      await requireCapability(container.getDb().sql, params.id, userId, "export")
      const record = await exports().get(params.exportId)
      if (record.cleanupId !== params.id) throw AppError.notFound(EXPORT_NOT_FOUND)
      reply.status(200).send(toHostExportDTO(record))
    },
  )

  route(
    app,
    "downloadHostExport",
    { config: { rateLimit: EXPORT_DOWNLOAD_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const params = parse(DownloadHostExportRequestSchema, request.params)
      const record = await exports().get(params.id)
      if (record.requestedBy !== userId) throw AppError.notFound(EXPORT_NOT_FOUND)
      if (record.cleanupId === null) throw AppError.notFound(EXPORT_NOT_FOUND)
      await requireCapability(container.getDb().sql, record.cleanupId, userId, "export")
      const payload: DownloadHostExportResponse = await exports().downloadUrl(record)
      reply.status(200).send(payload)
    },
  )
}
