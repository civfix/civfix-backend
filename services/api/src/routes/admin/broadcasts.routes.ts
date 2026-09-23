import {
  AppError,
  AdminBroadcastListQuerySchema,
  AdminHostListQuerySchema,
  SetHostMessagingSuspendedRequestSchema,
  type AdminBroadcastListResponse,
  type AdminHostListResponse,
  type SetHostMessagingSuspendedResponse,
} from "@civfix/shared"
import { createHash } from "node:crypto"
import type { FastifyInstance, FastifyRequest } from "fastify"
import type { Container } from "../../di.js"
import { requireAuth } from "../../auth/context.js"
import { route } from "../../versioning/route.js"
import { parse } from "../_validate.js"
import { encodeTimeCursor, parseTimeCursor } from "../../db/cursor-helpers.js"
import { makeDrizzleBroadcastRepository } from "../../services/host/broadcast-repository.drizzle.js"
import type { BroadcastRepository } from "../../services/host/broadcast-repository.js"

export interface AdminBroadcastOverrides {
  repo: BroadcastRepository
}

declare module "fastify" {
  interface FastifyInstance {
    adminBroadcastOverrides?: AdminBroadcastOverrides
  }
}

export const ADMIN_BROADCAST_DEFAULT_LIMIT = 50

export const ADMIN_HOST_DEFAULT_LIMIT = 50

export const ADMIN_HOST_DEFAULT_WINDOW_DAYS = 30

function mergeParams(request: FastifyRequest): Record<string, unknown> {
  const params = (request.params ?? {}) as Record<string, unknown>
  const body = (request.body ?? {}) as Record<string, unknown>
  return { ...body, ...params }
}

export async function registerAdminBroadcastRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  const csrfProtect = container.csrf.protect
  const broadcastRepo = (): BroadcastRepository =>
    app.adminBroadcastOverrides?.repo ?? makeDrizzleBroadcastRepository(container.getDb().sql)

  route(app, "adminListBroadcasts", async (request, reply) => {
    requireAuth(request)
    const query = parse(AdminBroadcastListQuerySchema, request.query)
    const limit = query.limit ?? ADMIN_BROADCAST_DEFAULT_LIMIT
    const cursor = parseTimeCursor(query.cursor, { direction: "desc" })
    const rows = await broadcastRepo().listAdmin({
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.kind !== undefined ? { kind: query.kind } : {}),
      ...(query.cleanupId !== undefined ? { cleanupId: query.cleanupId } : {}),
      ...(query.createdBy !== undefined ? { createdBy: query.createdBy } : {}),
      ...(query.from !== undefined ? { from: new Date(query.from) } : {}),
      ...(query.to !== undefined ? { to: new Date(query.to) } : {}),
      cursor: cursor === null ? null : { createdAt: cursor.at, id: cursor.id },
      limit: limit + 1,
    })
    const page = rows.slice(0, limit)
    const last = page.at(-1)
    const payload: AdminBroadcastListResponse = {
      items: page.map((row) => ({
        id: row.id,
        cleanupId: row.cleanupId,
        eventTitle: row.eventTitle,
        kind: row.kind,
        status: row.status,
        subjectHash:
          row.subject === null
            ? null
            : createHash("sha256").update(row.subject).digest("hex").slice(0, 16),
        createdBy:
          row.createdBy === null
            ? null
            : {
                id: row.createdBy,
                name: row.createdByName ?? "Unknown",
                handle: row.createdByHandle ?? "",
                joined: row.createdByJoined?.toISOString() ?? "",
              },
        recipientCount: row.recipientCount,
        sentCount: row.sentCount,
        failedCount: row.failedCount,
        suppressedCount: row.suppressedCount,
        channels: row.channels,
        createdAt: row.createdAt.toISOString(),
        finishedAt: row.finishedAt?.toISOString() ?? null,
      })),
      nextCursor:
        rows.length > limit && last !== undefined
          ? encodeTimeCursor({ at: last.createdAt, id: last.id })
          : null,
    }
    reply.status(200).send(payload)
  })

  route(app, "adminListHosts", async (request, reply) => {
    requireAuth(request)
    const query = parse(AdminHostListQuerySchema, request.query ?? {})
    const limit = query.limit ?? ADMIN_HOST_DEFAULT_LIMIT
    const windowDays = query.windowDays ?? ADMIN_HOST_DEFAULT_WINDOW_DAYS
    const cursor = parseTimeCursor(query.cursor, { direction: "desc" })
    const rows = await broadcastRepo().listAdminHosts({
      ...(query.q !== undefined ? { q: query.q } : {}),
      ...(query.suspended !== undefined ? { suspended: query.suspended } : {}),
      windowStart: new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000),
      cursor: cursor === null ? null : { at: cursor.at, id: cursor.id },
      limit: limit + 1,
    })
    const page = rows.slice(0, limit)
    const last = page.at(-1)
    const payload: AdminHostListResponse = {
      items: page.map((row) => ({
        host: {
          id: row.userId,
          name: row.displayName,
          handle: row.handle ?? "",
          joined: row.joinedAt?.toISOString() ?? "",
        },
        messagingSuspended: row.messagingSuspended,
        suspendedAt: row.suspendedAt?.toISOString() ?? null,
        suspendedBy:
          row.suspendedById === null
            ? null
            : {
                id: row.suspendedById,
                name: row.suspendedByName ?? "Unknown",
                handle: row.suspendedByHandle ?? "",
                joined: row.suspendedByJoined?.toISOString() ?? "",
              },
        windowDays,
        broadcastCount: row.broadcastCount,
        recipientCount: row.recipientCount,
        sentCount: row.sentCount,
        failedCount: row.failedCount,
        suppressedCount: row.suppressedCount,
        lastBroadcastAt: row.lastBroadcastAt?.toISOString() ?? null,
        eventsMessaged: row.eventsMessaged,
      })),
      nextCursor:
        rows.length > limit && last !== undefined
          ? encodeTimeCursor({ at: last.sortAt, id: last.userId })
          : null,
    }
    reply.status(200).send(payload)
  })

  route(
    app,
    "adminSetHostMessagingSuspended",
    { preHandler: csrfProtect },
    async (request, reply) => {
      const operatorId = requireAuth(request)
      const body = parse(SetHostMessagingSuspendedRequestSchema, mergeParams(request))
      const found = await broadcastRepo().setHostMessagingSuspended(body.id, body.suspended, {
        action: body.suspended ? "host.messaging_suspended" : "host.messaging_restored",
        actorId: operatorId,
        target: `user:${body.id}`,
        meta: { reason: body.reason },
      })
      if (!found) throw AppError.notFound("User not found.")
      const payload: SetHostMessagingSuspendedResponse = { ok: true, suspended: body.suspended }
      reply.status(200).send(payload)
    },
  )
}
