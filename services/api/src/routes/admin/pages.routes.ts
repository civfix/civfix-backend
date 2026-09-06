import {
  AdminEventPageListQuerySchema,
  AdminGetEventPageRequestSchema,
  AppError,
  FlagEventPageRequestSchema,
  UnpublishEventPageRequestSchema,
  type AdminEventPageListItemDTO,
  type AdminEventPageListResponse,
  type AdminGetEventPageResponse,
} from "@civfix/shared"
import type { FastifyInstance, FastifyRequest } from "fastify"
import type { Container } from "../../di.js"
import { requireAuth } from "../../auth/context.js"
import { route } from "../../versioning/route.js"
import { parse } from "../_validate.js"
import { writeAudit } from "../../services/admin/audit.js"
import { encodeTimeCursor, parseTimeCursor } from "../../db/cursor-helpers.js"
import {
  makeDrizzleAdminEventPageRepository,
  type AdminEventPageRepository,
  type AdminEventPageRow,
} from "../../services/host/admin-pages-repository.drizzle.js"
import { makeDrizzleHostRegistrationRepository } from "../../services/host/registration-repository.drizzle.js"
import { toEventPageDTO } from "../../services/host/registration-dto.js"
import { makeEventMediaPresigner } from "../../services/host/event-media.js"

export const ADMIN_EVENT_PAGE_DEFAULT_LIMIT = 50

export interface AdminEventPageOverrides {
  repo: AdminEventPageRepository
}

declare module "fastify" {
  interface FastifyInstance {
    adminEventPageOverrides?: AdminEventPageOverrides
  }
}

function mergeParams(request: FastifyRequest): Record<string, unknown> {
  const params = (request.params ?? {}) as Record<string, unknown>
  const body = (request.body ?? {}) as Record<string, unknown>
  return { ...body, ...params }
}

function toDTO(row: AdminEventPageRow): AdminEventPageListItemDTO {
  return {
    cleanupId: row.cleanupId,
    slug: row.slug,
    title: row.title,
    status: row.status,
    visibility: row.visibility,
    organizer:
      row.organizerId === null
        ? null
        : {
            id: row.organizerId,
            name: row.organizerName ?? "Unknown",
            handle: row.organizerHandle ?? "",
            joined: row.organizerJoined?.toISOString() ?? "",
          },
    orgName: row.orgName,
    viewCount: row.viewCount,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    flaggedAt: row.flaggedAt?.toISOString() ?? null,
    flagReason: row.flagReason,
    flaggedBy:
      row.flaggedById === null
        ? null
        : {
            id: row.flaggedById,
            name: row.flaggedByName ?? "Unknown",
            handle: row.flaggedByHandle ?? "",
            joined: row.flaggedByJoined?.toISOString() ?? "",
          },
  }
}

export async function registerAdminEventPageRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  const csrfProtect = container.csrf.protect
  const repo = (): AdminEventPageRepository =>
    app.adminEventPageOverrides?.repo ?? makeDrizzleAdminEventPageRepository(container.getDb().sql)

  route(app, "adminListEventPages", async (request, reply) => {
    requireAuth(request)
    const query = parse(AdminEventPageListQuerySchema, request.query)
    const limit = query.limit ?? ADMIN_EVENT_PAGE_DEFAULT_LIMIT
    const cursor = parseTimeCursor(query.cursor, { direction: "desc" })
    const rows = await repo().list({
      ...(query.q !== undefined ? { q: query.q } : {}),
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.flagged !== undefined ? { flagged: query.flagged } : {}),
      cursor: cursor === null ? null : { at: cursor.at, id: cursor.id },
      limit: limit + 1,
    })
    const page = rows.slice(0, limit)
    const last = page.at(-1)
    const payload: AdminEventPageListResponse = {
      items: page.map(toDTO),
      nextCursor:
        rows.length > limit && last !== undefined
          ? encodeTimeCursor({ at: last.sortAt, id: last.pageId })
          : null,
    }
    reply.status(200).send(payload)
  })

  route(app, "adminGetEventPage", async (request, reply) => {
    requireAuth(request)
    const { id } = parse(AdminGetEventPageRequestSchema, request.params)
    const record = await makeDrizzleHostRegistrationRepository(container.getDb().sql).getPage(id)
    if (record === null) throw AppError.notFound("Signup page not found.")
    const coverUrl =
      record.coverKey === null
        ? null
        : await makeEventMediaPresigner(container.storage)(record.coverKey, { forceSigned: true })
    const payload: AdminGetEventPageResponse = toEventPageDTO(record, coverUrl)
    reply.status(200).send(payload)
  })

  route(app, "adminFlagEventPage", { preHandler: csrfProtect }, async (request, reply) => {
    const operatorId = requireAuth(request)
    const body = parse(FlagEventPageRequestSchema, mergeParams(request))
    const row = await repo().setFlagged(body.id, {
      flagged: body.flagged,
      reason: body.reason ?? null,
      operatorId,
    })
    if (row === null) throw AppError.notFound("Signup page not found.")
    await writeAudit(container.getDb().sql, {
      action: body.flagged ? "event_page.flagged" : "event_page.unflagged",
      actorId: operatorId,
      target: `cleanup:${body.id}`,
      meta: { reason: body.reason ?? null },
    })
    reply.status(200).send(toDTO(row))
  })

  route(app, "adminUnpublishEventPage", { preHandler: csrfProtect }, async (request, reply) => {
    const operatorId = requireAuth(request)
    const body = parse(UnpublishEventPageRequestSchema, mergeParams(request))
    const row = await repo().unpublish(body.id)
    if (row === null) throw AppError.notFound("Signup page not found.")
    await writeAudit(container.getDb().sql, {
      action: "event_page.unpublished",
      actorId: operatorId,
      target: `cleanup:${body.id}`,
      meta: { reason: body.reason },
    })
    reply.status(200).send(toDTO(row))
  })
}
