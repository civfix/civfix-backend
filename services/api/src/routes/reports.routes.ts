/**
 * Report route plugin.
 *
 *   POST   /reports             [auth][csrf]  create a report (idempotent). 401 for anonymous callers
 *                                             (anonymous submissions go through /anon/reports, a later step).
 *   GET    /reports/:id         [anon-ok]     fetch a report (held/hidden 404 to non-owners).
 *   GET    /reports             [auth]        the caller's own reports, cursor-paginated.
 *   GET    /map/reports         [anon-ok]     clustered/pinned report points for a bbox + zoom.
 *   POST   /reports/:id/follow  [auth][csrf]  follow a report.
 *   DELETE /reports/:id/follow  [auth][csrf]  unfollow a report.
 *
 * Bodies/params/queries are validated against the @civfix/shared Zod schemas via the same `parse` ->
 * AppError.validation pattern as the auth/map/media routes. The DB handle + seams are reached lazily
 * inside handlers (via container) so merely mounting the plugin opens no connection.
 *
 * The report service is built per request from either an injected override bundle (tests: an in-memory
 * repo + fake jurisdiction/presign, so the whole flow runs offline) or from the container (production:
 * the Drizzle/PostGIS repo, the real jurisdiction service, and the Storage seam for presigning media).
 */

import {
  CreateReportRequestSchema,
  ListReportsInBBoxRequestSchema,
  PaginationQuerySchema,
  IdSchema,
  AppError,
  type ReportDTO,
  type GetReportResponse,
  type ListMyReportsResponse,
  type ReportClusterResponse,
  type FollowReportResponse,
} from "@civfix/shared"
import { ZodError, z, type ZodTypeAny } from "zod"
import type { FastifyInstance, FastifyRequest } from "fastify"
import type { Container } from "../di.js"
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
import { route } from "../versioning/route.js"
import { BBoxQueryParam, CategoriesQueryParam } from "./query-encoding.js"

/**
 * Optional injected report-service dependencies (tests). When present, the routes build the service
 * from these instead of the container, which lets the whole create/get/list/map/follow HTTP flow run
 * offline (no Docker): an in-memory repo, a fake jurisdiction resolver, and a fake media presigner. In
 * production it is left unset and the routes build the Drizzle-backed repo + real seams lazily.
 */
export interface ReportServiceOverrides {
  repo: ReportRepository
  resolveJurisdictionGeoid?: ReportServiceDeps["resolveJurisdictionGeoid"]
  presignMedia?: ReportServiceDeps["presignMedia"]
  newId?: ReportServiceDeps["newId"]
  now?: ReportServiceDeps["now"]
}

declare module "fastify" {
  interface FastifyInstance {
    /** Injected report-service overrides (tests). See ReportServiceOverrides. */
    reportOverrides?: ReportServiceOverrides
  }
}

/** Path param schema for the routes that take a report UUID in the URL. */
const ReportIdParamsSchema = z.object({ id: IdSchema }).strict()

/**
 * Query schema for GET /map/reports, decoding EXACTLY what the shared client sends (see
 * ./query-encoding.ts): bbox as a single JSON-encoded object param, categories as repeated params (or a
 * CSV for resilience), and a scalar zoom. We decode here, then re-validate the assembled shape against
 * the shared nested ListReportsInBBoxRequest below so the wire contract stays the single source of
 * truth. NOT .strict(): qs may surface extra/unknown params (and tolerating them is more robust for a
 * public GET), but the re-validation against the shared .strict() schema still rejects a malformed body.
 */
/**
 * zoom decoder (P2): the client sends a scalar; we coerce then HARD-bound it. The shared schema's
 * `zoom: z.number()` is frozen and does not clamp, and the clustering math (clusterCellSizeDeg) has no
 * NaN/range guard of its own - a NaN zoom would map every point to a "NaN:NaN" grid cell and emit a
 * single cluster at NaN coords (which serializes to null -> a broken pin). z.coerce.number() turns a
 * non-numeric string into NaN, so we explicitly reject non-finite via .int() (NaN/Infinity fail int) and
 * bound to a sane web tile range [0, 22]. A bad zoom is now a clean 422, not a corrupt cluster.
 */
const ZoomQueryParam = z.coerce.number().int().min(0).max(22)

const MapReportsQuerySchema = z.object({
  bbox: BBoxQueryParam,
  categories: CategoriesQueryParam.optional(),
  zoom: ZoomQueryParam,
})

export async function registerReportRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  /** Build the report service from injected overrides (tests) or the container seams (production). */
  function service(): ReportService {
    const overrides = app.reportOverrides
    if (overrides) {
      return makeReportService({
        repo: overrides.repo,
        resolveJurisdictionGeoid:
          overrides.resolveJurisdictionGeoid ?? (() => Promise.resolve(null)),
        presignMedia: overrides.presignMedia ?? defaultPresign(container),
        ...(overrides.newId !== undefined ? { newId: overrides.newId } : {}),
        ...(overrides.now !== undefined ? { now: overrides.now } : {}),
      })
    }

    const sql = container.getDb().sql
    const repo: ReportRepository = makeDrizzleReportRepository(sql)
    return makeReportService({
      repo,
      resolveJurisdictionGeoid: async (lat, lng) => {
        const jurisdiction = makeJurisdictionService({
          sql,
          geocoder: container.geocoder,
          jobs: container.jobs,
        })
        const resolved = await jurisdiction.resolveForPoint(lat, lng)
        return resolved?.geoid ?? null
      },
      presignMedia: defaultPresign(container),
    })
  }

  // -------------------------------------------------------------------------
  // POST /reports  [auth][csrf]
  // -------------------------------------------------------------------------
  route(app, "createReport", { preHandler: csrfProtect }, async (request, reply) => {
    // Anonymous callers must use /anon/reports (the next step); a report here requires a signed-in user.
    const userId = requireAuth(request)
    const body = parse(CreateReportRequestSchema, request.body)
    // The create response IS a ReportDTO (the shared contract has no distinct CreateReportResponse).
    // 201 Created on first insert; an idempotent replay also returns 201 with the original ReportDTO
    // (the effect already happened, and the body is the same report - the client cannot tell, by design).
    const dto: ReportDTO = await service().createReport(body, { userId })
    reply.status(201).send(dto)
  })

  // -------------------------------------------------------------------------
  // GET /reports/:id  (anon-ok)
  // -------------------------------------------------------------------------
  route(app, "getReport", async (request, reply) => {
    const { id } = parse(ReportIdParamsSchema, request.params)
    const dto: GetReportResponse = await service().getReport(id, ownerOf(request))
    reply.status(200).send(dto)
  })

  // -------------------------------------------------------------------------
  // GET /reports  [auth]  (the caller's own reports)
  // -------------------------------------------------------------------------
  route(app, "listMyReports", async (request, reply) => {
    const userId = requireAuth(request)
    const pagination = parse(PaginationQuerySchema, request.query)
    const payload: ListMyReportsResponse = await service().listMyReports(userId, pagination)
    reply.status(200).send(payload)
  })

  // -------------------------------------------------------------------------
  // GET /map/reports  (anon-ok)
  // -------------------------------------------------------------------------
  route(app, "mapReports", async (request, reply) => {
    // Decode the client's wire form (JSON bbox + repeated categories + scalar zoom).
    const q = parse(MapReportsQuerySchema, request.query)
    // Re-validate the assembled shape against the shared schema so the wire contract is the single
    // source of truth. q.categories is already a validated ReportCategory[] (or undefined = no filter).
    const validated = parse(ListReportsInBBoxRequestSchema, {
      bbox: q.bbox,
      ...(q.categories !== undefined ? { categories: q.categories } : {}),
      zoom: q.zoom,
    })
    const payload: ReportClusterResponse = await service().listReportsInBBox(
      validated.bbox,
      validated.categories ?? null,
      validated.zoom,
    )
    reply.status(200).send(payload)
  })

  // -------------------------------------------------------------------------
  // POST /reports/:id/follow  [auth][csrf]
  // -------------------------------------------------------------------------
  route(app, "followReport", { preHandler: csrfProtect }, async (request, reply) => {
    const userId = requireAuth(request)
    const { id } = parse(ReportIdParamsSchema, request.params)
    const payload: FollowReportResponse = await service().followReport(userId, id)
    reply.status(200).send(payload)
  })

  // -------------------------------------------------------------------------
  // DELETE /reports/:id/follow  [auth][csrf]
  // -------------------------------------------------------------------------
  route(app, "unfollowReport", { preHandler: csrfProtect }, async (request, reply) => {
    const userId = requireAuth(request)
    const { id } = parse(ReportIdParamsSchema, request.params)
    const payload: FollowReportResponse = await service().unfollowReport(userId, id)
    reply.status(200).send(payload)
  })
}

/** Build the default media presigner over the container's Storage seam (presign url + optional thumb). */
function defaultPresign(container: Container): ReportServiceDeps["presignMedia"] {
  return async (r2Key: string, thumbKey: string | null) => {
    const url = await container.storage.presignGet(r2Key, MEDIA_GET_URL_TTL_SEC)
    if (thumbKey === null) return { url }
    const thumbUrl = await container.storage.presignGet(thumbKey, MEDIA_GET_URL_TTL_SEC)
    return { url, thumbUrl }
  }
}

/** Derive the owner/viewer context from the resolved auth on the request. */
function ownerOf(request: FastifyRequest): { userId?: string | undefined; anonSessionId?: string | undefined } {
  const auth = request.auth
  return {
    userId: auth?.userId ?? undefined,
    anonSessionId: auth?.anonSessionId ?? undefined,
  }
}

/**
 * Validate `data` against a Zod schema, throwing AppError.validation (422 with field details) on
 * failure so the canonical envelope is returned instead of a generic 500. Mirrors the other routes.
 */
function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  try {
    return schema.parse(data)
  } catch (err) {
    if (err instanceof ZodError) {
      const fields: Record<string, string> = {}
      for (const issue of err.issues) {
        const key = issue.path.length > 0 ? issue.path.join(".") : "_"
        fields[key] = issue.message
      }
      throw AppError.validation(fields)
    }
    throw err
  }
}
