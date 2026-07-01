
import {
  CreateReportRequestSchema,
  ListReportsInBBoxRequestSchema,
  ListReportsSearchRequestSchema,
  ResolveReportRequestSchema,
  UnlistReportRequestSchema,
  PaginationQuerySchema,
  IdSchema,
  ReportRefOrIdSchema,
  type ReportDTO,
  type GetReportResponse,
  type ListMyReportsResponse,
  type ListReportsSearchResponse,
  type ReportClusterResponse,
  type FollowReportResponse,
} from "@civfix/shared"
import { z } from "zod"
import type { FastifyInstance, FastifyRequest } from "fastify"
import type { Container } from "../di.js"
import type { Sql } from "../db/client.js"
import { requireAuth } from "../auth/context.js"
import { csrfProtect } from "../auth/csrf.js"
import { makeJurisdictionService } from "../services/jurisdiction-service.js"
import { MEDIA_GET_URL_TTL_SEC } from "../services/media-intake-service.js"
import {
  makeReportService,
  type ReportRepository,
  type ReportService,
  type ReportServiceDeps,
} from "../services/report-service.js"
import { makeDrizzleReportRepository } from "../services/report-repository.drizzle.js"
import { resolveJurisdictionCode } from "../db/reference-code.js"
import { makeDrizzleCleanupRepository } from "../services/cleanup-repository.drizzle.js"
import { makeDrizzleChatRepository } from "../services/chat-repository.drizzle.js"
import { makeDrizzleDiscussionRepository } from "../services/discussion-repository.drizzle.js"
import { effectiveJurisdictionHandle } from "../services/discussion-service.js"
import { route } from "../versioning/route.js"
import { parse } from "./_validate.js"
import { BBoxQueryParam, CategoriesQueryParam, TypesQueryParam } from "./query-encoding.js"

const CREATE_REPORT_RATE_LIMIT = { max: 20, timeWindow: "1 minute" } as const

export interface ReportServiceOverrides {
  repo: ReportRepository
  resolveJurisdictionGeoid?: ReportServiceDeps["resolveJurisdictionGeoid"]
  resolveJurisdictionCode?: ReportServiceDeps["resolveJurisdictionCode"]
  reverseGeocode?: ReportServiceDeps["reverseGeocode"]
  presignMedia?: ReportServiceDeps["presignMedia"]
  loadLinkedEventsForReports?: ReportServiceDeps["loadLinkedEventsForReports"]
  loadDiscussionMeta?: ReportServiceDeps["loadDiscussionMeta"]
  newId?: ReportServiceDeps["newId"]
  now?: ReportServiceDeps["now"]
}

declare module "fastify" {
  interface FastifyInstance {
    reportOverrides?: ReportServiceOverrides
  }
}

const ReportIdParamsSchema = z.object({ id: IdSchema }).strict()

const ReportRefOrIdParamsSchema = z.object({ id: ReportRefOrIdSchema }).strict()

const ZoomQueryParam = z.coerce.number().int().min(0).max(22)

const MapReportsQuerySchema = z
  .object({
    bbox: BBoxQueryParam,
    categories: CategoriesQueryParam.optional(),
    types: TypesQueryParam.optional(),
    zoom: ZoomQueryParam,
  })
  .transform((q) => ({
    bbox: q.bbox,
    ...(q.categories !== undefined ? { categories: q.categories } : {}),
    ...(q.types !== undefined ? { types: q.types } : {}),
    zoom: q.zoom,
  }))
  .pipe(ListReportsInBBoxRequestSchema)

const SearchReportsQuerySchema = z
  .object({
    q: z.string().optional(),
    categories: CategoriesQueryParam.optional(),
    types: TypesQueryParam.optional(),
    cursor: z.string().optional(),
    limit: z.coerce.number().int().positive().max(50).optional(),
  })
  .transform((q) => ({
    ...(q.q !== undefined ? { q: q.q } : {}),
    ...(q.categories !== undefined ? { categories: q.categories } : {}),
    ...(q.types !== undefined ? { types: q.types } : {}),
    ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
    ...(q.limit !== undefined ? { limit: q.limit } : {}),
  }))
  .pipe(ListReportsSearchRequestSchema)

const MapReportsResponseJsonSchema = {
  type: "object",
  properties: {
    clusters: {
      type: "array",
      items: {
        type: "object",
        properties: {
          lat: { type: "number" },
          lng: { type: "number" },
          count: { type: "integer" },
        },
        required: ["lat", "lng", "count"],
      },
    },
    pins: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          category: {
            type: "string",
            enum: ["trash", "recycling", "graffiti", "hazard", "encampment", "water", "other"],
          },
          type: {
            type: "string",
            enum: ["dump", "encampment", "graffiti", "infrastructure", "pavement", "vegetation", "other"],
          },
          lat: { type: "number" },
          lng: { type: "number" },
          status: {
            type: "string",
            enum: [
              "submitted",
              "held",
              "published",
              "acknowledged",
              "in_progress",
              "resolved",
              "rejected",
            ],
          },
          title: { type: "string", nullable: true },
          description: { type: "string", nullable: true },
          thumbUrl: { type: "string", nullable: true },
        },
        required: ["id", "category", "lat", "lng", "status"],
      },
    },
    counts: {
      type: "object",
      additionalProperties: { type: "number" },
    },
  },
  required: ["clusters", "pins"],
} as const

export async function registerReportRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  function service(): ReportService {
    const overrides = app.reportOverrides
    if (overrides) {
      return makeReportService({
        repo: overrides.repo,
        resolveJurisdictionGeoid:
          overrides.resolveJurisdictionGeoid ?? (() => Promise.resolve(null)),
        ...(overrides.resolveJurisdictionCode !== undefined
          ? { resolveJurisdictionCode: overrides.resolveJurisdictionCode }
          : {}),
        presignMedia: overrides.presignMedia ?? defaultPresign(container),
        ...(overrides.reverseGeocode !== undefined ? { reverseGeocode: overrides.reverseGeocode } : {}),
        ...(overrides.loadLinkedEventsForReports !== undefined
          ? { loadLinkedEventsForReports: overrides.loadLinkedEventsForReports }
          : {}),
        ...(overrides.loadDiscussionMeta !== undefined
          ? { loadDiscussionMeta: overrides.loadDiscussionMeta }
          : {}),
        ...(overrides.newId !== undefined ? { newId: overrides.newId } : {}),
        ...(overrides.now !== undefined ? { now: overrides.now } : {}),
      })
    }

    const sql = container.getDb().sql
    const repo: ReportRepository = makeDrizzleReportRepository(sql)
    const cleanupRepo = makeDrizzleCleanupRepository(sql)
    const discussionRepo = makeDrizzleDiscussionRepository(sql)
    const chatRepo = makeDrizzleChatRepository(sql)
    return makeReportService({
      repo,
      loadLinkedEventsForReports: (reportIds) => cleanupRepo.loadLinkedEventsForReports(reportIds),
      loadDiscussionMeta: async (reportId) => {
        const [count, report] = await Promise.all([
          chatRepo.countReportMessages(reportId),
          discussionRepo.findReportForDiscussion(reportId),
        ])
        const jurisdiction = report?.jurisdiction ?? null
        return {
          discussionCount: count,
          cityHandle:
            jurisdiction !== null
              ? effectiveJurisdictionHandle({
                  handle: jurisdiction.handle,
                  name: jurisdiction.name,
                })
              : null,
          cityName: jurisdiction?.name ?? null,
          canForwardToCity:
            jurisdiction !== null &&
            jurisdiction.contactEmail !== null &&
            jurisdiction.contactEmail !== "",
        }
      },
      resolveJurisdictionGeoid: async (lat, lng) => {
        const jurisdiction = makeJurisdictionService({
          sql,
          geocoder: container.geocoder,
          jobs: container.jobs,
          jurisdictionLookup: container.jurisdictionLookup,
        })
        const resolved = await jurisdiction.resolveForPoint(lat, lng)
        return resolved?.geoid ?? null
      },
      resolveJurisdictionCode: (geoid) => resolveJurisdictionCode(sql, geoid),
      reverseGeocode: async (lat, lng) =>
        (await container.streetReverseGeocode(lat, lng)) ?? container.geocoder.cityStateLabel(lat, lng),
      presignMedia: defaultPresign(container),
      jobs: container.jobs,
      isReportVerified: (userId) => isReportVerified(sql, userId),
      logger: app.log,
    })
  }

  route(
    app,
    "createReport",
    { preHandler: csrfProtect, config: { rateLimit: CREATE_REPORT_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const body = parse(CreateReportRequestSchema, request.body)
      const dto: ReportDTO = await service().createReport(body, { userId })
      reply.status(201).send(dto)
    },
  )

  route(app, "getReport", async (request, reply) => {
    const { id } = parse(ReportRefOrIdParamsSchema, request.params)
    const dto: GetReportResponse = await service().getReport(id, ownerOf(request))
    reply.status(200).send(dto)
  })

  route(app, "listMyReports", async (request, reply) => {
    const userId = requireAuth(request)
    const pagination = parse(PaginationQuerySchema, request.query)
    const payload: ListMyReportsResponse = await service().listMyReports(userId, pagination)
    reply.status(200).send(payload)
  })

  route(app, "mapReports", { schema: { response: { 200: MapReportsResponseJsonSchema } } }, async (request, reply) => {
    const validated = parse(MapReportsQuerySchema, request.query)
    const payload: ReportClusterResponse = await service().listReportsInBBox(
      validated.bbox,
      validated.categories ?? null,
      validated.types ?? null,
      validated.zoom,
    )
    reply.header("Cache-Control", "public, max-age=60")
    reply.status(200).send(payload)
  })

  route(app, "searchReports", async (request, reply) => {
    const validated = parse(SearchReportsQuerySchema, request.query)
    const payload: ListReportsSearchResponse = await service().searchReports(validated)
    reply.status(200).send(payload)
  })

  route(app, "followReport", { preHandler: csrfProtect }, async (request, reply) => {
    const userId = requireAuth(request)
    const { id } = parse(ReportIdParamsSchema, request.params)
    const payload: FollowReportResponse = await service().followReport(userId, id)
    reply.status(200).send(payload)
  })

  route(app, "unfollowReport", { preHandler: csrfProtect }, async (request, reply) => {
    const userId = requireAuth(request)
    const { id } = parse(ReportIdParamsSchema, request.params)
    const payload: FollowReportResponse = await service().unfollowReport(userId, id)
    reply.status(200).send(payload)
  })

  route(app, "resolveReport", { preHandler: csrfProtect }, async (request, reply) => {
    const userId = requireAuth(request)
    const { id } = parse(ReportIdParamsSchema, request.params)
    const body = parse(ResolveReportRequestSchema, { ...(request.body as object), id })
    const dto: ReportDTO = await service().resolveReport(userId, id, body.resolved)
    reply.status(200).send(dto)
  })

  route(app, "unlistReport", { preHandler: csrfProtect }, async (request, reply) => {
    const userId = requireAuth(request)
    const { id } = parse(ReportIdParamsSchema, request.params)
    const body = parse(UnlistReportRequestSchema, { ...(request.body as object), id })
    const dto: ReportDTO = await service().unlistReport(userId, id, body.unlisted)
    reply.status(200).send(dto)
  })
}

async function isReportVerified(sql: Sql, userId: string): Promise<boolean> {
  const rows = await sql<{ report_verified: boolean }[]>`
    SELECT report_verified FROM user_moderation WHERE user_id = ${userId} LIMIT 1
  `
  return rows[0]?.report_verified ?? false
}

function defaultPresign(container: Container): ReportServiceDeps["presignMedia"] {
  return async (r2Key: string, thumbKey: string | null) => {
    const url = await container.storage.presignGet(r2Key, MEDIA_GET_URL_TTL_SEC)
    if (thumbKey === null) return { url }
    const thumbUrl = await container.storage.presignGet(thumbKey, MEDIA_GET_URL_TTL_SEC)
    return { url, thumbUrl }
  }
}

function ownerOf(request: FastifyRequest): { userId?: string | undefined; anonSessionId?: string | undefined } {
  const auth = request.auth
  return {
    userId: auth?.userId ?? undefined,
    anonSessionId: auth?.anonSessionId ?? undefined,
  }
}
