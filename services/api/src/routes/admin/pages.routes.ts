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
import { writeAudit, type WriteAuditInput } from "../../services/admin/audit.js"
import { paginateKeyset, parseKeysetCursor } from "../../db/cursor-helpers.js"
import {
  makeDrizzleAdminEventPageRepository,
  type AdminEventPageRepository,
  type AdminEventPageRow,
} from "../../services/host/admin-pages-repository.drizzle.js"
import { makeDrizzleHostRegistrationRepository } from "../../services/host/registration-repository.drizzle.js"
import { toEventPageDTO } from "../../services/host/registration-dto.js"
import { makeEventMediaPresigner } from "../../services/host/event-media.js"

const ADMIN_EVENT_PAGE_DEFAULT_LIMIT = 50

type RecordAudit = (entry: WriteAuditInput) => Promise<unknown>

export interface AdminEventPageOverrides {
  repo: AdminEventPageRepository
  audit?: RecordAudit
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

  /**
   * A moderation effect and its audit row commit together: a failed audit rolls the flag or unpublish
   * back instead of leaving an operator action applied with no record of who took it.
   */
  function moderate<T>(
    fn: (pages: AdminEventPageRepository, recordAudit: RecordAudit) => Promise<T>,
  ): Promise<T> {
    const overrides = app.adminEventPageOverrides
    if (overrides) return fn(overrides.repo, overrides.audit ?? (() => Promise.resolve()))
    return container
      .getDb()
      .sql.begin((tx) =>
        fn(makeDrizzleAdminEventPageRepository(tx), (entry) => writeAudit(tx, entry)),
      ) as Promise<T>
  }

  route(app, "adminListEventPages", async (request, reply) => {
    requireAuth(request)
    const query = parse(AdminEventPageListQuerySchema, request.query)
    const limit = query.limit ?? ADMIN_EVENT_PAGE_DEFAULT_LIMIT
    const rows = await repo().list({
      ...(query.q !== undefined ? { q: query.q } : {}),
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.flagged !== undefined ? { flagged: query.flagged } : {}),
      cursor: parseKeysetCursor(query.cursor, { direction: "desc" }),
      limit: limit + 1,
    })
    const { items, nextCursor } = paginateKeyset(rows, limit, (row) => ({
      atText: row.cursorAt,
      id: row.pageId,
    }))
    const payload: AdminEventPageListResponse = { items: items.map(toDTO), nextCursor }
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
    const row = await moderate(async (pages, recordAudit) => {
      const flagged = await pages.setFlagged(body.id, {
        flagged: body.flagged,
        reason: body.reason ?? null,
        operatorId,
      })
      if (flagged === null) return null
      await recordAudit({
        action: body.flagged ? "event_page.flagged" : "event_page.unflagged",
        actorId: operatorId,
        target: `cleanup:${body.id}`,
        meta: { reason: body.reason ?? null },
      })
      return flagged
    })
    if (row === null) throw AppError.notFound("Signup page not found.")
    reply.status(200).send(toDTO(row))
  })

  route(app, "adminUnpublishEventPage", { preHandler: csrfProtect }, async (request, reply) => {
    const operatorId = requireAuth(request)
    const body = parse(UnpublishEventPageRequestSchema, mergeParams(request))
    const row = await moderate(async (pages, recordAudit) => {
      const unpublished = await pages.unpublish(body.id)
      if (unpublished === null) return null
      await recordAudit({
        action: "event_page.unpublished",
        actorId: operatorId,
        target: `cleanup:${body.id}`,
        meta: { reason: body.reason },
      })
      return unpublished
    })
    if (row === null) throw AppError.notFound("Signup page not found.")
    reply.status(200).send(toDTO(row))
  })
}
