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
  AppError,
  type TileInfoResponse,
  type JurisdictionDTO,
  type ReverseLabelResponse,
  type MapCleanupsResponse,
  type CleanupPinDTO,
} from "@civfix/shared"
import { ZodError, z, type ZodTypeAny } from "zod"
import type { FastifyInstance } from "fastify"
import type { Container } from "../di.js"
import { makeJurisdictionService } from "../services/jurisdiction-service.js"
import { BBoxQueryParam } from "./query-encoding.js"

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
  app.get("/map/tileinfo", async (_request, reply) => {
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
    reply.status(200).send(payload)
  })

  // -------------------------------------------------------------------------
  // POST /map/resolve-jurisdiction  (anon-ok)
  // -------------------------------------------------------------------------
  app.post("/map/resolve-jurisdiction", async (request, reply) => {
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
  app.post("/map/reverse-label", async (request, reply) => {
    const { lat, lng } = parse(ReverseLabelRequestSchema, request.body)
    const label = await container.geocoder.cityStateLabel(lat, lng)
    const payload: ReverseLabelResponse = { cityStateLabel: label ?? "" }
    reply.status(200).send(payload)
  })

  // -------------------------------------------------------------------------
  // GET /map/cleanups  (anon-ok)
  // -------------------------------------------------------------------------
  app.get("/map/cleanups", async (request, reply) => {
    const q = parse(CleanupsQuerySchema, request.query)
    // Re-validate via the shared schema so the wire contract is enforced from the single source.
    const { bbox, when } = parse(ListCleanupsInBBoxRequestSchema, {
      bbox: q.bbox,
      ...(q.when !== undefined ? { when: q.when } : {}),
    })

    const pins = await queryCleanupPins(container, bbox, when)
    const payload: MapCleanupsResponse = { pins }
    reply.status(200).send(payload)
  })
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
