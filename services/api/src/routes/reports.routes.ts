
import {
  CreateReportRequestSchema,
  ListReportsInBBoxRequestSchema,
  ListReportsSearchRequestSchema,
  ResolveReportRequestSchema,
  UnlistReportRequestSchema,
  PaginationQuerySchema,
  IdSchema,
  ReportRefOrIdSchema,
  ReportCategorySchema,
  ReportTypeSchema,
  ReportStatusSchema,
  type ReportDTO,
  type GetReportResponse,
  type ListMyReportsResponse,
  type ListReportsSearchResponse,
  type ReportClusterResponse,
} from "@civfix/shared"
import { z } from "zod"
import type { FastifyInstance, FastifyRequest } from "fastify"
import type { Container } from "../di.js"
import type { Sql } from "../db/client.js"
import { requireAuth } from "../auth/context.js"
import {
  makeCachedAddressResolver,
  makeGeoidResolver,
} from "../services/route-geo-helpers.js"
import { makeMediaPresigner, makePrivateMediaPresigner } from "../services/media-presign.js"
import { perIdentity } from "../plugins/rate-limit.js"
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
import { makeReportChatRepository } from "../services/report-chat-repository.drizzle.js"
import { makeContainerReportChatEmitter } from "../services/report-chat-emitter.js"
import { makeDrizzleDiscussionRepository } from "../services/discussion-repository.drizzle.js"
import { effectiveJurisdictionHandle } from "../services/discussion-mentions.js"
import { route } from "../versioning/route.js"
import { parse, trimTextFields } from "./_validate.js"
import { CappedBBoxQueryParam, CategoriesQueryParam, TypesQueryParam } from "./query-encoding.js"

export const CREATE_REPORT_RATE_LIMIT = perIdentity({ max: 20, timeWindow: "1 minute", hostMax: 60 })

const MAP_REPORTS_RATE_LIMIT = { max: 60, timeWindow: "1 minute" } as const
const SEARCH_REPORTS_RATE_LIMIT = { max: 30, timeWindow: "1 minute" } as const

export interface ReportServiceOverrides {
  repo: ReportRepository
  resolveJurisdictionGeoid?: ReportServiceDeps["resolveJurisdictionGeoid"]
  resolveJurisdictionCode?: ReportServiceDeps["resolveJurisdictionCode"]
  resolveAddress?: ReportServiceDeps["resolveAddress"]
  presignMedia?: ReportServiceDeps["presignMedia"]
  presignPrivateMedia?: ReportServiceDeps["presignPrivateMedia"]
  loadLinkedEventsForReports?: ReportServiceDeps["loadLinkedEventsForReports"]
  loadDiscussionMeta?: ReportServiceDeps["loadDiscussionMeta"]
  loadReportChatMeta?: ReportServiceDeps["loadReportChatMeta"]
  joinReportChatAsOwner?: ReportServiceDeps["joinReportChatAsOwner"]
  reportChatEmitter?: ReportServiceDeps["reportChatEmitter"]
  newId?: ReportServiceDeps["newId"]
  now?: ReportServiceDeps["now"]
}

declare module "fastify" {
  interface FastifyInstance {
    reportOverrides?: ReportServiceOverrides
  }
}

const ReportIdParamsSchema = z.object({ id: IdSchema }).strict()

export const CreateReportBodySchema = trimTextFields(
  CreateReportRequestSchema,
  "title",
  "description",
  "addr",
)

const ReportRefOrIdParamsSchema = z.object({ id: ReportRefOrIdSchema }).strict()

const ZoomQueryParam = z.coerce.number().int().min(0).max(22)

const MapReportsQuerySchema = z
  .object({
    bbox: CappedBBoxQueryParam,
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
            enum: [...ReportCategorySchema.options],
          },
          type: {
            type: "string",
            enum: [...ReportTypeSchema.options],
          },
          lat: { type: "number" },
          lng: { type: "number" },
          status: {
            type: "string",
            enum: [...ReportStatusSchema.options],
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
  const csrfProtect = container.csrf.protect

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
        presignMedia: overrides.presignMedia ?? makeMediaPresigner(container.storage),
        presignPrivateMedia:
          overrides.presignPrivateMedia ?? makePrivateMediaPresigner(container.storage),
        ...(overrides.resolveAddress !== undefined
          ? { resolveAddress: overrides.resolveAddress }
          : {}),
        ...(overrides.loadLinkedEventsForReports !== undefined
          ? { loadLinkedEventsForReports: overrides.loadLinkedEventsForReports }
          : {}),
        ...(overrides.loadDiscussionMeta !== undefined
          ? { loadDiscussionMeta: overrides.loadDiscussionMeta }
          : {}),
        ...(overrides.loadReportChatMeta !== undefined
          ? { loadReportChatMeta: overrides.loadReportChatMeta }
          : {}),
        ...(overrides.joinReportChatAsOwner !== undefined
          ? { joinReportChatAsOwner: overrides.joinReportChatAsOwner }
          : {}),
        ...(overrides.reportChatEmitter !== undefined
          ? { reportChatEmitter: overrides.reportChatEmitter }
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
    const reportChatRepo = makeReportChatRepository(sql)
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
            container.env.REPORT_AUTOFORWARD_ENABLED &&
            jurisdiction !== null &&
            jurisdiction.contactEmail !== null &&
            jurisdiction.contactEmail !== "",
        }
      },
      loadReportChatMeta: async (reportId, viewerUserId) => {
        const rows = await sql<
          { joined: boolean; member_count: number; message_count: number; unread: number }[]
        >`
          SELECT
            EXISTS (
              SELECT 1 FROM report_chat_members m
              WHERE m.report_id = ${reportId} AND m.user_id = ${viewerUserId}
            ) AS joined,
            (
              SELECT count(*)::int FROM report_chat_members m WHERE m.report_id = ${reportId}
            ) AS member_count,
            (
              SELECT count(*)::int
              FROM chat_messages cm
              WHERE cm.report_id = ${reportId} AND cm.deleted_at IS NULL
            ) AS message_count,
            COALESCE((
              SELECT count(*)::int
              FROM report_chat_members mem
              JOIN chat_messages cm ON cm.report_id = mem.report_id
              WHERE mem.report_id = ${reportId}
                AND mem.user_id = ${viewerUserId}
                AND cm.deleted_at IS NULL
                AND cm.sender_id IS DISTINCT FROM ${viewerUserId}
                AND cm.created_at > GREATEST(mem.joined_at, COALESCE(mem.last_read_at, to_timestamp(0)))
            ), 0) AS unread
        `
        const row = rows[0]
        return {
          joined: row?.joined ?? false,
          memberCount: row?.member_count ?? 0,
          messageCount: row?.message_count ?? 0,
          unread: row?.unread ?? 0,
        }
      },
      resolveJurisdictionGeoid: makeGeoidResolver(container),
      resolveJurisdictionCode: (geoid) => resolveJurisdictionCode(sql, geoid),
      resolveAddress: makeCachedAddressResolver(container),
      presignMedia: makeMediaPresigner(container.storage),
      presignPrivateMedia: makePrivateMediaPresigner(container.storage),
      jobs: container.jobs,
      autoForwardEnabled: container.env.REPORT_AUTOFORWARD_ENABLED,
      isReportVerified: (userId) => isReportVerified(sql, userId),
      joinReportChatAsOwner: (reportId, userId) => reportChatRepo.join(reportId, userId, "owner"),
      reportChatEmitter: makeContainerReportChatEmitter(container, app.log),
      logger: app.log,
    })
  }

  route(
    app,
    "createReport",
    { preHandler: csrfProtect, config: { rateLimit: CREATE_REPORT_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const body = parse(CreateReportBodySchema, request.body)
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

  route(app, "mapReports", { schema: { response: { 200: MapReportsResponseJsonSchema } }, config: { rateLimit: MAP_REPORTS_RATE_LIMIT } }, async (request, reply) => {
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

  route(app, "searchReports", { config: { rateLimit: SEARCH_REPORTS_RATE_LIMIT } }, async (request, reply) => {
    const validated = parse(SearchReportsQuerySchema, request.query)
    const payload: ListReportsSearchResponse = await service().searchReports(validated)
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

function ownerOf(request: FastifyRequest): { userId?: string | undefined; anonSessionId?: string | undefined } {
  const auth = request.auth
  return {
    userId: auth?.userId ?? undefined,
    anonSessionId: auth?.anonSessionId ?? undefined,
  }
}
