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
import { makeDrizzleDiscussionRepository } from "../services/discussion-repository.drizzle.js"
import { effectiveJurisdictionHandle } from "../services/discussion-service.js"
import { route } from "../versioning/route.js"
import { parse } from "./_validate.js"
import { BBoxQueryParam, CategoriesQueryParam, TypesQueryParam } from "./query-encoding.js"

// Tighter per-IP cap on authed report-create (vs the global 300/min): a write triggers a jurisdiction
// resolve + media presign + DB insert. 20/min is ample for a real reporter while bounding spam.
const CREATE_REPORT_RATE_LIMIT = { max: 20, timeWindow: "1 minute" } as const

/**
 * Optional injected report-service dependencies (tests). When present, the routes build the service
 * from these instead of the container, which lets the whole create/get/list/map/follow HTTP flow run
 * offline (no Docker): an in-memory repo, a fake jurisdiction resolver, and a fake media presigner. In
 * production it is left unset and the routes build the Drizzle-backed repo + real seams lazily.
 */
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
    /** Injected report-service overrides (tests). See ReportServiceOverrides. */
    reportOverrides?: ReportServiceOverrides
  }
}

/** Path param schema for the routes that take a report UUID in the URL. */
const ReportIdParamsSchema = z.object({ id: IdSchema }).strict()

// GET /reports/:id is resolve-either (issue #56 / ROUTING): the URL id may be a UUID primary key OR a
// reference_code. Validate it with the looser shared ReportRefOrIdSchema (a 1..64-char opaque string); the
// service branches uuid-shaped -> findReportById, else -> findReportByReferenceCode. ONLY this route is
// relaxed — every other by-id route keeps the strict UUID schema (mutations key off the loaded DTO's id).
const ReportRefOrIdParamsSchema = z.object({ id: ReportRefOrIdSchema }).strict()

// zoom decoder: the shared `zoom: z.number()` does not clamp and clusterCellSizeDeg has no range guard, so
// a NaN zoom would emit a cluster at NaN coords (serializes to null = a broken pin). .int() rejects
// non-finite (NaN/Infinity fail int); bound to a sane web tile range. A bad zoom is a clean 422.
const ZoomQueryParam = z.coerce.number().int().min(0).max(22)

// GET /map/reports query: decode the client's wire form (JSON bbox + repeated/CSV categories + scalar
// zoom), then `.pipe` the assembled object through the shared .strict() contract in ONE parse pass — the
// wire contract stays the single source of truth without a second full Zod pass on this hottest read.
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

// GET /reports/search query: same decode-then-pipe single-parse pattern as the map read.
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

/**
 * Compiled-serializer JSON Schema for the GET /map/reports 200 body (perf).
 *
 * This is the ONE genuinely array-heavy hot read path (clustered map pins on every pan/zoom), so we give
 * Fastify a response schema for it. Fastify compiles `schema.response[200]` with fast-json-stringify,
 * which serializes array/object payloads ~2-3x faster than the generic JSON.stringify fallback it uses
 * for unschematized routes - measurable event-loop CPU on the 4-core box under map-panning traffic.
 *
 * It is a hand-written JSON Schema (not a zod-to-json-schema conversion) that mirrors the emitted shape
 * EXACTLY - the shared `ReportClusterResponseSchema` (clusters[]/pins[]/optional counts) and the service's
 * `listReportsInBBox` return. This matters: fast-json-stringify serializes ONLY what the schema declares
 * and silently DROPS any property the schema omits, so a drift here would corrupt the payload. Fields:
 *   - clusters: ReportClusterDTO  = { lat, lng, count }                          (grid clusters, low zoom)
 *   - pins:     ReportPinDTO       = { id, category, type, lat, lng, status, title?, thumbUrl? } (high zoom;
 *                                     the additive nullable title/thumbUrl carry a tapped pin's preview)
 *   - counts:   Partial<Record<ReportCategory, number>>  (optional; the service omits it for an empty view)
 * The two enums (category, status) are inlined from ReportCategorySchema / ReportStatusSchema; `counts`
 * uses additionalProperties:number so the per-category integer values serialize through. The shape is
 * exercised by the existing /map/reports route tests, which assert the full cluster/pin/counts payload.
 */
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
          // Fine-grained issue type (0021), inlined from ReportTypeSchema. fast-json-stringify DROPS any
          // undeclared property, so `type` MUST be listed for the map pin to carry it on the wire (the
          // service's toMapPinDTO populates it). Additive: NOT in `required`, preserving the prior contract.
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
          // Additive pin preview (mirrors the shared ReportPinDTOSchema's nullable-optional title/thumbUrl):
          // the report's headline + a presigned thumbnail of its first photo, so a tapped pin can render a
          // callout without a second detail fetch. Declared nullable so the serializer emits an explicit
          // null thumbUrl for a report with no media (title is omitted by the service when null). They are
          // NOT in `required`, keeping the prior {id,category,lat,lng,status} contract for any caller.
          // NOTE: fast-json-stringify DROPS any property not declared here, so `description` MUST be listed
          // for the map pin to actually carry it on the wire (the service's toMapPinDTO populates it).
          title: { type: "string", nullable: true },
          description: { type: "string", nullable: true },
          thumbUrl: { type: "string", nullable: true },
        },
        required: ["id", "category", "lat", "lng", "status"],
      },
    },
    // Per-category pin counts (optional; absent for an empty view). Keys are ReportCategory values; the
    // additionalProperties:number declaration is what lets fast-json-stringify emit the integer values.
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
  /** Build the report service from injected overrides (tests) or the container seams (production). */
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
    // The cleanup repo backs the report's "linked events" gallery (loadLinkedEventsForReports). Reusing it
    // keeps the event<->report link reads in one place; the report service stays decoupled via the seam.
    const cleanupRepo = makeDrizzleCleanupRepository(sql)
    // The discussion repo backs the report DETAIL's additive discussion/city meta (discussionCount +
    // cityHandle/cityName + canForwardToCity). Reusing the SAME repo keeps the discussion reads in one
    // place; the report service stays decoupled via the optional loadDiscussionMeta seam.
    const discussionRepo = makeDrizzleDiscussionRepository(sql)
    return makeReportService({
      repo,
      loadLinkedEventsForReports: (reportIds) => cleanupRepo.loadLinkedEventsForReports(reportIds),
      // Additive discussion/city meta for GET /reports/:id. Best-effort (report-service swallows a throw):
      // count the non-deleted top-level messages, and resolve the report's own jurisdiction handle/name +
      // whether it has a contact email on file (so the client can offer "@city forward"). cityHandle uses
      // the SAME effective-handle rule the discussion service uses (stored handle, else derived from name).
      loadDiscussionMeta: async (reportId) => {
        const [count, report] = await Promise.all([
          discussionRepo.countTopLevel(reportId),
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
          // Write-time Census fallback: on a local resolver miss, self-map via the Census Geocoder so the
          // report gets a non-null geoid instead of "Unmapped" (fake/no-op outside production).
          jurisdictionLookup: container.jurisdictionLookup,
        })
        const resolved = await jurisdiction.resolveForPoint(lat, lng)
        return resolved?.geoid ?? null
      },
      // Resolve the geoid's compact jurisdictions.code (the reference-code JURCODE segment) pre-tx; 0
      // when the geoid is null or has no code on file (D5). The report repo allocates the code from it.
      resolveJurisdictionCode: (geoid) => resolveJurisdictionCode(sql, geoid),
      // Street-level Photon address, falling back to the local "City, ST" label so a report almost
      // always gets a location text even when Photon is unreachable. Best-effort: null leaves addr empty.
      reverseGeocode: async (lat, lng) =>
        (await container.streetReverseGeocode(lat, lng)) ?? container.geocoder.cityStateLabel(lat, lng),
      presignMedia: defaultPresign(container),
      // AUTO-FORWARD (D9 / #56): the Jobs seam + the report_verified gate read. createReport enqueues
      // report.autoforward post-commit ONLY when the reporter is report_verified (singletonKey=reportId).
      jobs: container.jobs,
      isReportVerified: (userId) => isReportVerified(sql, userId),
      logger: app.log,
    })
  }

  // POST /reports  [auth][csrf]  (anonymous callers use /anon/reports). 201 on first insert; an idempotent
  // replay also returns 201 with the original ReportDTO (the client cannot tell, by design).
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

  // GET /reports/:id  (anon-ok) — resolve-either: id may be a UUID or a reference_code (issue #56).
  route(app, "getReport", async (request, reply) => {
    const { id } = parse(ReportRefOrIdParamsSchema, request.params)
    const dto: GetReportResponse = await service().getReport(id, ownerOf(request))
    reply.status(200).send(dto)
  })

  // GET /reports  [auth]  (the caller's own reports)
  route(app, "listMyReports", async (request, reply) => {
    const userId = requireAuth(request)
    const pagination = parse(PaginationQuerySchema, request.query)
    const payload: ListMyReportsResponse = await service().listMyReports(userId, pagination)
    reply.status(200).send(payload)
  })

  // GET /map/reports  (anon-ok)
  route(app, "mapReports", { schema: { response: { 200: MapReportsResponseJsonSchema } } }, async (request, reply) => {
    // One parse: MapReportsQuerySchema decodes the wire form and pipes it through the shared contract.
    const validated = parse(MapReportsQuerySchema, request.query)
    const payload: ReportClusterResponse = await service().listReportsInBBox(
      validated.bbox,
      validated.categories ?? null,
      validated.types ?? null,
      validated.zoom,
    )
    // Anon-ok and identical across all viewers for a given bbox+zoom+categories: a short shared TTL lets
    // browsers and Cloudflare absorb repeated pans without re-running the spatial query + serialization.
    // (Edge caching also needs a CF cache rule for /v1/map/*; the origin header alone only buys browser
    // revalidation.)
    reply.header("Cache-Control", "public, max-age=60")
    reply.status(200).send(payload)
  })

  // GET /reports/search  (anon-ok)
  route(app, "searchReports", async (request, reply) => {
    const validated = parse(SearchReportsQuerySchema, request.query)
    const payload: ListReportsSearchResponse = await service().searchReports(validated)
    reply.status(200).send(payload)
  })

  // POST /reports/:id/follow  [auth][csrf]
  route(app, "followReport", { preHandler: csrfProtect }, async (request, reply) => {
    const userId = requireAuth(request)
    const { id } = parse(ReportIdParamsSchema, request.params)
    const payload: FollowReportResponse = await service().followReport(userId, id)
    reply.status(200).send(payload)
  })

  // DELETE /reports/:id/follow  [auth][csrf]
  route(app, "unfollowReport", { preHandler: csrfProtect }, async (request, reply) => {
    const userId = requireAuth(request)
    const { id } = parse(ReportIdParamsSchema, request.params)
    const payload: FollowReportResponse = await service().unfollowReport(userId, id)
    reply.status(200).send(payload)
  })

  // POST /reports/:id/resolve  [auth][csrf]  (the reporter marks their own report resolved / reopens it)
  route(app, "resolveReport", { preHandler: csrfProtect }, async (request, reply) => {
    const userId = requireAuth(request)
    const { id } = parse(ReportIdParamsSchema, request.params)
    // Merge the authoritative path id into the body before validating (the URL value wins over the body's).
    const body = parse(ResolveReportRequestSchema, { ...(request.body as object), id })
    const dto: ReportDTO = await service().resolveReport(userId, id, body.resolved)
    reply.status(200).send(dto)
  })

  // POST /reports/:id/unlist  [auth][csrf]  (the reporter hides their own report / re-lists it)
  route(app, "unlistReport", { preHandler: csrfProtect }, async (request, reply) => {
    const userId = requireAuth(request)
    const { id } = parse(ReportIdParamsSchema, request.params)
    const body = parse(UnlistReportRequestSchema, { ...(request.body as object), id })
    const dto: ReportDTO = await service().unlistReport(userId, id, body.unlisted)
    reply.status(200).send(dto)
  })
}

/**
 * Read a reporter's earned report_verified flag (user_moderation.report_verified, D7). A user with no
 * moderation row reads false (no row, no trust). Backs the auto-forward enqueue gate (D9 / #56).
 */
async function isReportVerified(sql: Sql, userId: string): Promise<boolean> {
  const rows = await sql<{ report_verified: boolean }[]>`
    SELECT report_verified FROM user_moderation WHERE user_id = ${userId} LIMIT 1
  `
  return rows[0]?.report_verified ?? false
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
