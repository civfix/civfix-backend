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
import type { FastifyInstance, FastifyRequest } from "fastify"
import type { Container } from "../../di.js"
import { requireAuth } from "../../auth/context.js"
import { perIdentity } from "../../plugins/rate-limit.js"
import { route } from "../../versioning/route.js"
import { parse } from "../_validate.js"
import { requireCapability } from "../../services/host/authz.js"
import { writeAudit } from "../../services/admin/audit.js"
import { HOST_EXPORT_JOB } from "../../services/host/broadcast-queues.js"
import { makeCommsRuntime } from "../../services/host/comms-wiring.js"
import type { CommsRuntime } from "../../services/host/comms-wiring.js"
import { toHostExportDTO, type HostExportService } from "../../services/host/export-service.js"

export const EXPORT_REQUEST_RATE_LIMIT = perIdentity({ max: 10, timeWindow: "1 hour" })
export const EXPORT_READ_RATE_LIMIT = perIdentity({ max: 60, timeWindow: "1 minute" })
export const EXPORT_DOWNLOAD_RATE_LIMIT = perIdentity({ max: 30, timeWindow: "1 minute" })

export interface HostExportOverrides {
  exports: HostExportService
}

declare module "fastify" {
  interface FastifyInstance {
    hostExportOverrides?: HostExportOverrides
  }
}

function mergeParams(request: FastifyRequest): Record<string, unknown> {
  const params = (request.params ?? {}) as Record<string, unknown>
  const body = (request.body ?? {}) as Record<string, unknown>
  return { ...body, ...params }
}

function mergeQuery(request: FastifyRequest): Record<string, unknown> {
  const params = (request.params ?? {}) as Record<string, unknown>
  const query = (request.query ?? {}) as Record<string, unknown>
  return { ...query, ...params }
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
      const body = parse(RequestEventExportRequestSchema, mergeParams(request))
      await requireCapability(container.getDb().sql, body.id, userId, "export")
      const payload: HostExportDTO = await exports().request({
        cleanupId: body.id,
        organizationId: null,
        requestedBy: userId,
        kind: body.kind,
        filters: body.filters,
      })
      await container.jobs.enqueue(
        HOST_EXPORT_JOB,
        { exportId: payload.id },
        { singletonKey: `export:${payload.id}`, retryLimit: 2 },
      )
      await writeAudit(container.getDb().sql, {
        action: "event.roster_exported",
        actorId: userId,
        target: `cleanup:${body.id}`,
        meta: { exportId: payload.id, kind: body.kind },
      })
      reply.status(200).send(payload)
    },
  )

  route(
    app,
    "listEventExports",
    { config: { rateLimit: EXPORT_READ_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const query = parse(ListEventExportsRequestSchema, mergeQuery(request))
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
      const params = parse(GetEventExportRequestSchema, mergeParams(request))
      await requireCapability(container.getDb().sql, params.id, userId, "export")
      const record = await exports().get(params.exportId)
      if (record.cleanupId !== params.id) throw AppError.notFound("Export not found")
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
      if (record.requestedBy !== userId) throw AppError.notFound("Export not found")
      if (record.cleanupId === null) throw AppError.notFound("Export not found")
      await requireCapability(container.getDb().sql, record.cleanupId, userId, "export")
      const payload: DownloadHostExportResponse = await exports().downloadUrl(record)
      reply.status(200).send(payload)
    },
  )
}
