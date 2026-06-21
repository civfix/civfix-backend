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
  AppError,
  type ReportDTO,
  type GetReportResponse,
  type ListMyReportsResponse,
  type ListReportsSearchResponse,
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
import { makeDrizzleCleanupRepository } from "../services/cleanup-repository.drizzle.js"
import { makeDrizzleDiscussionRepository } from "../services/discussion-repository.drizzle.js"
import { effectiveJurisdictionHandle } from "../services/discussion-service.js"
import { makePhotonReverseGeocode } from "../adapters/reverse-geocode.photon.js"
import { route } from "../versioning/route.js"
import { BBoxQueryParam, CategoriesQueryParam, TypesQueryParam } from "./query-encoding.js"

/** Shared street-level reverse geocoder (Photon). Falls back to the local "City, ST" label per call. */
const photonReverseGeocode = makePhotonReverseGeocode()

/**
 * Optional injected report-service dependencies (tests). When present, the routes build the service
 * from these instead of the container, which lets the whole create/get/list/map/follow HTTP flow run
 * offline (no Docker): an in-memory repo, a fake jurisdiction resolver, and a fake media presigner. In
 * production it is left unset and the routes build the Drizzle-backed repo + real seams lazily.
 */
export interface ReportServiceOverrides {
  repo: ReportRepository
  resolveJurisdictionGeoid?: ReportServiceDeps["resolveJurisdictionGeoid"]
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
  // Fine-grained type filter (0021): applied alongside categories. Same repeated-param/CSV wire form.
  types: TypesQueryParam.optional(),
  zoom: ZoomQueryParam,
})

/**
 * Query schema for GET /reports/search, decoding EXACTLY what the shared client sends: a scalar `q`, a
 * scalar `cursor`, a coerced scalar `limit`, and `categories` as repeated params (or a CSV) decoded via
 * the SAME CategoriesQueryParam the map uses. We decode here, then re-validate the assembled shape against
 * the shared ListReportsSearchRequestSchema below so the wire contract stays the single source of truth.
 * NOT .strict(): a public GET may surface extra/unknown params from qs; the shared .strict() re-validation
 * still rejects a malformed assembled body.
 */
const SearchReportsQuerySchema = z.object({
  q: z.string().optional(),
  categories: CategoriesQueryParam.optional(),
  // Fine-grained type filter (0021): applied alongside categories. Same repeated-param/CSV wire form.
  types: TypesQueryParam.optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().positive().max(50).optional(),
})

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
            enum: ["trash", "recycling", "graffiti", "hazard", "water", "other"],
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
      // Street-level Photon address, falling back to the local "City, ST" label so a report almost
      // always gets a location text even when Photon is unreachable. Best-effort: null leaves addr empty.
      reverseGeocode: async (lat, lng) =>
        (await photonReverseGeocode(lat, lng)) ?? container.geocoder.cityStateLabel(lat, lng),
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
  route(app, "mapReports", { schema: { response: { 200: MapReportsResponseJsonSchema } } }, async (request, reply) => {
    // Decode the client's wire form (JSON bbox + repeated categories + scalar zoom).
    const q = parse(MapReportsQuerySchema, request.query)
    // Re-validate the assembled shape against the shared schema so the wire contract is the single
    // source of truth. q.categories is already a validated ReportCategory[] (or undefined = no filter).
    const validated = parse(ListReportsInBBoxRequestSchema, {
      bbox: q.bbox,
      ...(q.categories !== undefined ? { categories: q.categories } : {}),
      ...(q.types !== undefined ? { types: q.types } : {}),
      zoom: q.zoom,
    })
    const payload: ReportClusterResponse = await service().listReportsInBBox(
      validated.bbox,
      validated.categories ?? null,
      validated.types ?? null,
      validated.zoom,
    )
    // Anon-ok and identical across all viewers for a given bbox+zoom+categories: a short shared TTL lets
    // browsers and Cloudflare absorb repeated pans/loads without re-running the spatial query + cluster
    // serialization every time. Kept short (60s) because report data is dynamic — mirrors GET /map/cleanups.
    // (Edge caching also needs a CF cache rule for /v1/map/*; the origin header alone only buys
    // browser-cache + revalidation.)
    reply.header("Cache-Control", "public, max-age=60")
    reply.status(200).send(payload)
  })

  // -------------------------------------------------------------------------
  // GET /reports/search  (anon-ok)
  // -------------------------------------------------------------------------
  route(app, "searchReports", async (request, reply) => {
    // Decode the client's wire form (scalar q/cursor/limit + repeated categories), then re-validate the
    // assembled shape against the shared schema so the wire contract is the single source of truth.
    // q.categories is already a validated ReportCategory[] (or undefined = no filter); the others pass
    // through. Mirrors GET /map/reports' decode-then-revalidate; public/optional-auth like the map read.
    const decoded = parse(SearchReportsQuerySchema, request.query)
    const validated = parse(ListReportsSearchRequestSchema, {
      ...(decoded.q !== undefined ? { q: decoded.q } : {}),
      ...(decoded.categories !== undefined ? { categories: decoded.categories } : {}),
      ...(decoded.types !== undefined ? { types: decoded.types } : {}),
      ...(decoded.cursor !== undefined ? { cursor: decoded.cursor } : {}),
      ...(decoded.limit !== undefined ? { limit: decoded.limit } : {}),
    })
    const payload: ListReportsSearchResponse = await service().searchReports(validated)
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

  // -------------------------------------------------------------------------
  // POST /reports/:id/resolve  [auth][csrf]  (the reporter marks their own report resolved / reopens it)
  // -------------------------------------------------------------------------
  route(app, "resolveReport", { preHandler: csrfProtect }, async (request, reply) => {
    const userId = requireAuth(request)
    const { id } = parse(ReportIdParamsSchema, request.params)
    // Merge the authoritative path id into the body before validating (the client also sends it in the
    // body; the URL value wins) — mirrors the discussion routes' param+body reconciliation.
    const body = parse(ResolveReportRequestSchema, { ...(request.body as object), id })
    const dto: ReportDTO = await service().resolveReport(userId, id, body.resolved)
    reply.status(200).send(dto)
  })

  // -------------------------------------------------------------------------
  // POST /reports/:id/unlist  [auth][csrf]  (the reporter hides their own report from the public map / re-lists it)
  // -------------------------------------------------------------------------
  route(app, "unlistReport", { preHandler: csrfProtect }, async (request, reply) => {
    const userId = requireAuth(request)
    const { id } = parse(ReportIdParamsSchema, request.params)
    // Merge the authoritative path id into the body before validating (the client also sends it in the
    // body; the URL value wins) — mirrors the resolveReport route's param+body reconciliation.
    const body = parse(UnlistReportRequestSchema, { ...(request.body as object), id })
    const dto: ReportDTO = await service().unlistReport(userId, id, body.unlisted)
    reply.status(200).send(dto)
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
