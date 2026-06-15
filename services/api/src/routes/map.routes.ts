/**
 * Map route plugin (all endpoints anon-ok; no auth guard).
 *
 *   GET  /map/tileinfo             basemap metadata (OpenStreetMap / CARTO Voyager raster; never 500s).
 *   POST /map/resolve-jurisdiction LatLng -> JurisdictionDTO, or 200 null when outside coverage.
 *   POST /map/reverse-label        LatLng -> { cityStateLabel } via the Geocoder seam.
 *   GET  /map/cleanups             bbox (+ when?) -> lightweight cleanup pins with RSVP counts.
 *
 * Every body/query is validated against the @civfix/shared Zod schemas (see ./auth.routes.ts for the
 * shared `parse` helper rationale: Zod failures become AppError.validation -> the 422 envelope).
 *
 * NO-COVERAGE DECISION (resolve-jurisdiction): a point outside every known boundary returns HTTP 200
 * with a JSON `null` body, NOT 404. Rationale: for a public map endpoint, "this spot is not in our
 * curated coverage yet" is an ordinary, expected outcome rather than a client error. A 404 would
 * conflate it with a bad route/request and is awkward for clients to branch on; a typed 200-null lets
 * the caller render an "unsupported area" state with a trivial `=== null` check. The response is
 * `JurisdictionDTO | null`, so successful resolutions are unchanged.
 *
 * CLEANUPS CAP: results are capped at MAP_CLEANUPS_LIMIT pins to bound the payload for a wide bbox.
 * Pins are ordered by scheduled_at so the cap keeps the soonest events when the area is dense.
 */

import {
  ResolveJurisdictionRequestSchema,
  ReverseLabelRequestSchema,
  ListCleanupsInBBoxRequestSchema,
  SuggestContactRequestSchema,
  AppError,
  type TileInfoResponse,
  type JurisdictionDTO,
  type ReverseLabelResponse,
  type MapCleanupsResponse,
  type CleanupPinDTO,
  type SuggestContactResponse,
} from "@civfix/shared"
import { ZodError, z, type ZodTypeAny } from "zod"
import type { FastifyInstance } from "fastify"
import type { Container } from "../di.js"
import { makeJurisdictionService } from "../services/jurisdiction-service.js"
import { writeAudit } from "../services/admin/audit.js"
import { BBoxQueryParam } from "./query-encoding.js"
import { route } from "../versioning/route.js"

/** Max cleanup pins returned for a single bbox query. Documented in MapCleanupsResponse handling. */
export const MAP_CLEANUPS_LIMIT = 500

/**
 * Default basemap: the OpenStreetMap-derived CARTO Voyager raster XYZ template. This is the basemap the
 * clients render directly (plan override; see the GET /map/tileinfo handler). `{r}` is the optional
 * retina suffix ("@2x" on hi-dpi, empty otherwise) per the standard slippy-map convention. Overridable
 * via the optional TILES_RASTER_URL env var.
 */
export const CARTO_VOYAGER_RASTER_URL =
  "https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png"

/**
 * Query schema for GET /map/cleanups, decoding EXACTLY what the shared client sends: bbox as a single
 * JSON-encoded object param (see ./query-encoding.ts) plus an optional scalar `when`. We decode here,
 * then re-validate against the shared nested ListCleanupsInBBoxRequest so the contract stays the single
 * source of truth. (NOT .strict(); the re-validation against the shared .strict() schema is the gate.)
 */
const CleanupsQuerySchema = z.object({
  bbox: BBoxQueryParam,
  when: z.enum(["upcoming", "past"]).optional(),
})

/** Path param for the public suggest-contact route. */
const GeoidParamsSchema = z.object({ geoid: z.string().min(1) }).strict()

/**
 * Tight per-IP limit for the public suggest-contact write (mirrors the anon status limiter). Suggestions
 * are operator-reviewed and never auto-route, so a modest cap bounds spam without hurting real reporters.
 */
const SUGGEST_CONTACT_RATE_LIMIT = { max: 10, timeWindow: "1 minute" } as const

export async function registerMapRoutes(app: FastifyInstance, container: Container): Promise<void> {
  // -------------------------------------------------------------------------
  // GET /map/tileinfo  (anon-ok; pure env read, must never 500 on missing config)
  // -------------------------------------------------------------------------
  // PLAN OVERRIDE (supersedes civfixplan.md's MapLibre + Protomaps-pmtiles-on-R2 decision): the map
  // uses the OpenStreetMap (CARTO Voyager) RASTER basemap loaded directly by the clients. The platform
  // does NOT serve its own vector tiles; R2 is for media only. The clients already hardcode the CARTO
  // Voyager raster URL, so they no longer depend on this endpoint for the basemap. We keep the endpoint
  // (the @civfix/shared contract still defines it) and have it advertise that same raster basemap, so
  // anything reading tileinfo gets a consistent, working raster source. pmtilesUrl is "" ("no vector
  // basemap") and styleUrl is omitted. The field shapes are unchanged, so this stays non-breaking.
  route(app, "tileInfo", async (_request, reply) => {
    const env = container.env
    const payload: TileInfoResponse = {
      // No self-hosted vector basemap: "" is the documented "no pmtiles" signal. Clients use rasterUrl.
      pmtilesUrl: "",
      // CARTO Voyager raster XYZ template (OpenStreetMap-derived). TILES_RASTER_URL is an optional
      // override of this default; absent -> the public CARTO Voyager basemap CDN.
      rasterUrl: env.TILES_RASTER_URL ?? CARTO_VOYAGER_RASTER_URL,
      attribution: "(c) OpenStreetMap contributors, (c) CARTO",
      minZoom: env.TILES_MIN_ZOOM,
      maxZoom: env.TILES_MAX_ZOOM,
      bounds: env.TILES_BOUNDS,
    }
    // Cacheable: tileinfo is env-derived basemap metadata that only changes between deploys and is
    // fetched on every client cold start. A 1h browser/edge TTL lets clients and Cloudflare reuse it
    // instead of re-hitting the origin on every load. (Serving from the CF edge ALSO needs a cache rule
    // for /v1/map/* — CF does not cache JSON API paths by default even with Cache-Control.)
    reply.header("Cache-Control", "public, max-age=3600")
    reply.status(200).send(payload)
  })

  // -------------------------------------------------------------------------
  // POST /map/resolve-jurisdiction  (anon-ok)
  // -------------------------------------------------------------------------
  route(app, "resolveJurisdiction", async (request, reply) => {
    const { lat, lng } = parse(ResolveJurisdictionRequestSchema, request.body)
    const service = makeJurisdictionService({
      sql: container.getDb().sql,
      geocoder: container.geocoder,
      jobs: container.jobs,
    })
    const dto: JurisdictionDTO | null = await service.resolveForPoint(lat, lng)
    // 200 with a null body when the point is outside coverage (see file header for the rationale).
    reply.status(200).send(dto)
  })

  // -------------------------------------------------------------------------
  // POST /map/reverse-label  (anon-ok)
  // -------------------------------------------------------------------------
  route(app, "reverseLabel", async (request, reply) => {
    const { lat, lng } = parse(ReverseLabelRequestSchema, request.body)
    const label = await container.geocoder.cityStateLabel(lat, lng)
    const payload: ReverseLabelResponse = { cityStateLabel: label ?? "" }
    reply.status(200).send(payload)
  })

  // -------------------------------------------------------------------------
  // GET /map/cleanups  (anon-ok)
  // -------------------------------------------------------------------------
  route(app, "mapCleanups", async (request, reply) => {
    const q = parse(CleanupsQuerySchema, request.query)
    // Re-validate via the shared schema so the wire contract is enforced from the single source.
    const { bbox, when } = parse(ListCleanupsInBBoxRequestSchema, {
      bbox: q.bbox,
      ...(q.when !== undefined ? { when: q.when } : {}),
    })

    const pins = await queryCleanupPins(container, bbox, when)
    const payload: MapCleanupsResponse = { pins }
    // Anon-ok and identical across all viewers for a given bbox: a short shared TTL lets browsers and
    // Cloudflare absorb repeated pans/loads without re-serializing the full pin set every time. Kept
    // short (60s) because cleanup data is dynamic. (Edge caching also needs a CF cache rule for
    // /v1/map/*; the origin header alone only buys browser-cache + revalidation.)
    reply.header("Cache-Control", "public, max-age=60")
    reply.status(200).send(payload)
  })

  // -------------------------------------------------------------------------
  // POST /map/jurisdictions/:geoid/suggest-contact  (public, rate-limited)
  // -------------------------------------------------------------------------
  // A reporter in an UNMAPPED area offers a routing contact (an email and/or the city's reporting form,
  // at least one) plus an optional note. It is recorded as an audit_log `discovery.contact_suggested`
  // row (target jurisdiction:<geoid>) so it surfaces in the operator's discovery queue as a "Reporter"
  // note; it NEVER auto-routes. The geoid is taken from the PATH (authoritative) and injected into the
  // body before validation, so a caller need not echo it. 404 when the geoid is not a known jurisdiction.
  route(
    app,
    "suggestJurisdictionContact",
    { config: { rateLimit: SUGGEST_CONTACT_RATE_LIMIT } },
    async (request, reply) => {
      const { geoid } = parse(GeoidParamsSchema, request.params)
      const body = parse(SuggestContactRequestSchema, {
        ...(request.body as Record<string, unknown> | undefined),
        geoid,
      })

      const sql = container.getDb().sql
      const exists =
        (await sql`SELECT 1 FROM jurisdictions WHERE geoid = ${geoid} LIMIT 1`).length > 0
      if (!exists) throw AppError.notFound("Jurisdiction not found")

      await writeAudit(sql, {
        actorId: null,
        action: "discovery.contact_suggested",
        target: `jurisdiction:${geoid}`,
        meta: {
          email: body.email ?? null,
          formUrl: body.formUrl ?? null,
          note: body.note ?? null,
          source: "anon",
        },
      })

      const payload: SuggestContactResponse = { ok: true }
      reply.status(201).send(payload)
    },
  )
}

/**
 * Query cleanup pins whose Point geom intersects the bbox envelope, with a per-cleanup "going" count
 * from cleanup_members. `when` selects the time window:
 *   - "upcoming": scheduled_at >= now() AND status <> 'cancelled'
 *   - "past":     scheduled_at <  now()
 *   - omitted:    no time filter, but still excludes 'cancelled' (cancelled events are not shown).
 * Capped at MAP_CLEANUPS_LIMIT, ordered by soonest scheduled_at.
 */
async function queryCleanupPins(
  container: Container,
  bbox: { west: number; south: number; east: number; north: number },
  when: "upcoming" | "past" | undefined,
): Promise<CleanupPinDTO[]> {
  const sql = container.getDb().sql

  // Build the time/status predicate as a composable fragment so the spatial + cap parts stay shared.
  const timeFilter =
    when === "upcoming"
      ? sql`AND c.scheduled_at >= now() AND c.status <> 'cancelled'`
      : when === "past"
        ? sql`AND c.scheduled_at < now()`
        : sql`AND c.status <> 'cancelled'`

  const rows = await sql<
    { id: string; lng: number; lat: number; scheduled_at: Date; going: number }[]
  >`
    SELECT
      c.id,
      ST_X(c.geom) AS lng,
      ST_Y(c.geom) AS lat,
      c.scheduled_at,
      (SELECT count(*)::int FROM cleanup_members m WHERE m.cleanup_id = c.id) AS going
    FROM cleanups c
    WHERE ST_Intersects(
            c.geom,
            ST_MakeEnvelope(${bbox.west}, ${bbox.south}, ${bbox.east}, ${bbox.north}, 4326)
          )
      ${timeFilter}
    ORDER BY c.scheduled_at ASC
    LIMIT ${MAP_CLEANUPS_LIMIT}
  `

  return rows.map((r) => ({
    id: r.id,
    lat: r.lat,
    lng: r.lng,
    scheduledAt: r.scheduled_at.toISOString(),
    going: r.going,
  }))
}

/**
 * Validate `data` against a Zod schema, throwing AppError.validation (422 with field details) on
 * failure so the canonical envelope is returned instead of a generic 500. Mirrors auth.routes.ts.
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
