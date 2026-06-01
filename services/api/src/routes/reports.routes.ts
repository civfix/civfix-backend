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
 * Flat query schema for GET /map/reports. The bbox arrives as four coercible query params plus an
 * optional categories CSV and a zoom; we re-assemble + re-validate against the shared nested schema so
 * the wire contract stays the single source of truth (mirrors GET /map/cleanups).
 */
const MapReportsQuerySchema = z
  .object({
    west: z.coerce.number().min(-180).max(180),
    south: z.coerce.number().min(-90).max(90),
    east: z.coerce.number().min(-180).max(180),
    north: z.coerce.number().min(-90).max(90),
    categories: z.string().optional(),
    zoom: z.coerce.number(),
  })
  .strict()

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
  app.post("/reports", { preHandler: csrfProtect }, async (request, reply) => {
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
  app.get("/reports/:id", async (request, reply) => {
    const { id } = parse(ReportIdParamsSchema, request.params)
    const dto: GetReportResponse = await service().getReport(id, ownerOf(request))
    reply.status(200).send(dto)
  })

  // -------------------------------------------------------------------------
  // GET /reports  [auth]  (the caller's own reports)
  // -------------------------------------------------------------------------
  app.get("/reports", async (request, reply) => {
    const userId = requireAuth(request)
    const pagination = parse(PaginationQuerySchema, request.query)
    const payload: ListMyReportsResponse = await service().listMyReports(userId, pagination)
    reply.status(200).send(payload)
  })

  // -------------------------------------------------------------------------
  // GET /map/reports  (anon-ok)
  // -------------------------------------------------------------------------
  app.get("/map/reports", async (request, reply) => {
    const q = parse(MapReportsQuerySchema, request.query)
    // Split the CSV into raw tokens; the shared schema below validates each against ReportCategory, so
    // an unknown token becomes a 422 (not a silent drop or a 500). null categories means "no filter".
    const categoryTokens = splitCsv(q.categories)
    // Re-validate the assembled shape against the shared schema so the wire contract is the single source.
    const validated = parse(ListReportsInBBoxRequestSchema, {
      bbox: { west: q.west, south: q.south, east: q.east, north: q.north },
      ...(categoryTokens !== null ? { categories: categoryTokens } : {}),
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
  app.post("/reports/:id/follow", { preHandler: csrfProtect }, async (request, reply) => {
    const userId = requireAuth(request)
    const { id } = parse(ReportIdParamsSchema, request.params)
    const payload: FollowReportResponse = await service().followReport(userId, id)
    reply.status(200).send(payload)
  })

  // -------------------------------------------------------------------------
  // DELETE /reports/:id/follow  [auth][csrf]
  // -------------------------------------------------------------------------
  app.delete("/reports/:id/follow", { preHandler: csrfProtect }, async (request, reply) => {
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

/** Split a CSV into trimmed non-empty tokens (null when absent/empty). Validation happens downstream. */
function splitCsv(raw: string | undefined): string[] | null {
  if (raw === undefined || raw.trim() === "") return null
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  return parts.length > 0 ? parts : null
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
