/**
 * Map route plugin (all endpoints anon-ok; no auth guard).
 *
 *   GET  /map/tileinfo             basemap metadata (OpenStreetMap / CARTO Voyager raster; never 500s).
 *   POST /map/resolve-jurisdiction LatLng -> JurisdictionDTO, or 200 null when outside coverage.
 *   POST /map/reverse-label        LatLng -> { cityStateLabel } via the Geocoder seam.
 *   GET  /map/cleanups             bbox (+ when?) -> lightweight cleanup pins with RSVP counts.
 *
 * NO-COVERAGE DECISION (resolve-jurisdiction): a point outside every known boundary returns HTTP 200
 * with a JSON `null` body, NOT 404 — for a public map endpoint "this spot is not in our coverage yet" is
 * an ordinary outcome, and a typed 200-null lets the caller branch on `=== null`. The response is
 * `JurisdictionDTO | null`, so successful resolutions are unchanged.
 */

import {
  ResolveJurisdictionRequestSchema,
  ReverseLabelRequestSchema,
  SuggestPlacesRequestSchema,
  ListCleanupsInBBoxRequestSchema,
  SuggestContactRequestSchema,
  AppError,
  type TileInfoResponse,
  type JurisdictionDTO,
  type ReverseLabelResponse,
  type SuggestPlacesResponse,
  type MapCleanupsResponse,
  type SuggestContactResponse,
} from "@civfix/shared"
import { suggestAddresses } from "@civfix/shared/geocode"
import { z } from "zod"
import type { FastifyInstance } from "fastify"
import type { Container } from "../di.js"
import { makeRouteJurisdictionService } from "../services/route-geo-helpers.js"
import {
  makeCleanupMapRepository,
  MAP_CLEANUPS_LIMIT,
} from "../services/cleanup-map-repository.js"
import { writeAudit } from "../services/admin/audit.js"
import { CappedBBoxQueryParam } from "./query-encoding.js"
import { parse } from "./_validate.js"
import { route } from "../versioning/route.js"

export { MAP_CLEANUPS_LIMIT }

/**
 * Default basemap: the OpenStreetMap-derived CARTO Voyager raster XYZ template, rendered directly by the
 * clients (plan override; see the tileinfo handler). `{r}` is the optional retina suffix. Overridable via
 * the optional TILES_RASTER_URL env var.
 */
export const CARTO_VOYAGER_RASTER_URL =
  "https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png"

// Decode EXACTLY what the shared client sends (bbox as one JSON-encoded param + optional scalar `when`),
// then re-validate against the shared .strict() schema so the contract stays the single source of truth.
// The bbox carries the M14 area cap: this read is anon-ok and scans up to MAP_CLEANUPS_LIMIT rows with a
// correlated RSVP-count subquery per row, the same cost profile the reports map read caps.
const CleanupsQuerySchema = z.object({
  bbox: CappedBBoxQueryParam,
  when: z.enum(["upcoming", "past"]).optional(),
})

const GeoidParamsSchema = z.object({ geoid: z.string().min(1) }).strict()

// Tight per-IP limit for the public suggest-contact write (mirrors the anon status limiter). Suggestions
// are operator-reviewed and never auto-route, so a modest cap bounds spam without hurting real reporters.
const SUGGEST_CONTACT_RATE_LIMIT = { max: 10, timeWindow: "1 minute" } as const

// Per-IP cap on the anon-ok geocoder-backed POSTs: each hits the external Census seam + a DB upsert, so a
// tight per-route limit bounds an unauthenticated client driving hundreds of expensive outbound calls.
const GEOCODER_RATE_LIMIT = { max: 30, timeWindow: "1 minute" } as const

// M14 parity with reports.routes' MAP_REPORTS_RATE_LIMIT: the cleanup-pin read is equally anon-ok and
// equally expensive per request, and jittered bounds defeat the 60s Cache-Control. Same 60/min headroom,
// because a genuine pan/zoom session fires several requests per second while the cache warms.
const MAP_CLEANUPS_RATE_LIMIT = { max: 60, timeWindow: "1 minute" } as const

// fast-json-stringify response schema for the hot anon mapCleanups read (up to MAP_CLEANUPS_LIMIT pins);
// gives the 2-3x serialization path over the slow JSON.stringify fallback. Drops any property not listed.
const MapCleanupsResponseJsonSchema = {
  type: "object",
  properties: {
    pins: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          lat: { type: "number" },
          lng: { type: "number" },
          scheduledAt: { type: "string" },
          going: { type: "number" },
          eventKind: { type: "string", enum: ["cleanup", "other_volunteer"] },
        },
        required: ["id", "lat", "lng", "scheduledAt", "going", "eventKind"],
      },
    },
  },
  required: ["pins"],
} as const

export async function registerMapRoutes(app: FastifyInstance, container: Container): Promise<void> {
  // Same wiring as the reports/anon/cleanups resolvers — INCLUDING the write-time Census fallback. This
  // route used to omit it, so /map/resolve-jurisdiction answered 200-null ("not covered") for points that
  // self-map the moment the same user submits a report there. GEOCODER_RATE_LIMIT bounds the Census spend.
  //
  // cacheLookup: these endpoints are anon-ok and csrf-less, and the fallback's lazily-inserted row has a
  // NULL geom, so it can never become a local hit — without a memo a client repeating ONE point drove one
  // outbound Census request (and one write attempt) per request, at 30/min/IP, forever. The memo is
  // per-container, TTL-bounded and answer-identical; the submit paths stay uncached (route-geo-helpers).
  function jurisdictionService() {
    return makeRouteJurisdictionService(container, { cacheLookup: true })
  }

  // PLAN OVERRIDE (supersedes the MapLibre + Protomaps-pmtiles-on-R2 plan): the map uses the
  // OpenStreetMap (CARTO Voyager) RASTER basemap loaded directly by the clients; the platform serves no
  // vector tiles. Clients hardcode the raster URL, so they no longer depend on this endpoint, but the
  // contract still defines it, so it advertises the same raster basemap. pmtilesUrl "" = "no vector
  // basemap". Pure env read — must never 500 on missing config.
  route(app, "tileInfo", async (_request, reply) => {
    const env = container.env
    const payload: TileInfoResponse = {
      pmtilesUrl: "",
      rasterUrl: env.TILES_RASTER_URL ?? CARTO_VOYAGER_RASTER_URL,
      attribution: "(c) OpenStreetMap contributors, (c) CARTO",
      minZoom: env.TILES_MIN_ZOOM,
      maxZoom: env.TILES_MAX_ZOOM,
      bounds: env.TILES_BOUNDS,
    }
    // Env-derived basemap metadata only changes between deploys but is fetched on every cold start; a 1h
    // TTL lets clients/Cloudflare reuse it. (Edge caching ALSO needs a CF cache rule for /v1/map/* — CF
    // does not cache JSON API paths by default even with Cache-Control.)
    reply.header("Cache-Control", "public, max-age=3600")
    reply.status(200).send(payload)
  })

  route(
    app,
    "resolveJurisdiction",
    { config: { rateLimit: GEOCODER_RATE_LIMIT } },
    async (request, reply) => {
      const { lat, lng } = parse(ResolveJurisdictionRequestSchema, request.body)
      const dto: JurisdictionDTO | null = await jurisdictionService().resolveForPoint(lat, lng)
      // 200 with a null body when the point is outside coverage (see file header for the rationale).
      reply.status(200).send(dto)
    },
  )

  route(
    app,
    "reverseLabel",
    { config: { rateLimit: GEOCODER_RATE_LIMIT } },
    async (request, reply) => {
      const { lat, lng } = parse(ReverseLabelRequestSchema, request.body)
      const label = await container.geocoder.cityStateLabel(lat, lng)
      const payload: ReverseLabelResponse = { cityStateLabel: label ?? "" }
      reply.status(200).send(payload)
    },
  )

  // Forward address autocomplete proxy: dispatch Mapbox (when MAPBOX_TOKEN is set) -> Photon server-side
  // via the shared suggestAddresses helper, so no provider key is ever shipped to the client.
  route(
    app,
    "suggest",
    { config: { rateLimit: GEOCODER_RATE_LIMIT } },
    async (request, reply) => {
      const { q, proximity, proximityZoom, limit } = parse(SuggestPlacesRequestSchema, request.body)
      const suggestions = await suggestAddresses(q, {
        ...(proximity ? { proximity } : {}),
        ...(proximityZoom != null ? { proximityZoom } : {}),
        ...(limit != null ? { limit } : {}),
        ...(container.env.MAPBOX_TOKEN ? { mapboxToken: container.env.MAPBOX_TOKEN } : {}),
      })
      const payload: SuggestPlacesResponse = { suggestions }
      reply.status(200).send(payload)
    },
  )

  route(
    app,
    "mapCleanups",
    {
      schema: { response: { 200: MapCleanupsResponseJsonSchema } },
      config: { rateLimit: MAP_CLEANUPS_RATE_LIMIT },
    },
    async (request, reply) => {
      const q = parse(CleanupsQuerySchema, request.query)
      // Re-validate via the shared schema so the wire contract is enforced from the single source.
      const { bbox, when } = parse(ListCleanupsInBBoxRequestSchema, {
        bbox: q.bbox,
        ...(q.when !== undefined ? { when: q.when } : {}),
      })

      const repo = makeCleanupMapRepository(container.getDb().sql)
      const pins = await repo.listCleanupPins(bbox, when)
      const payload: MapCleanupsResponse = { pins }
      // Anon-ok and identical across viewers for a given bbox: a short shared TTL (60s; cleanup data is
      // dynamic) lets browsers/Cloudflare absorb repeated pans. (Edge caching also needs a CF cache rule
      // for /v1/map/*.)
      reply.header("Cache-Control", "public, max-age=60")
      reply.status(200).send(payload)
    },
  )

  // POST /map/jurisdictions/:geoid/suggest-contact (public, rate-limited): a reporter in an UNMAPPED area
  // offers a routing contact (email and/or the city's form) + an optional note. Recorded as an audit_log
  // `discovery.contact_suggested` row (target jurisdiction:<geoid>) so it surfaces in the operator's
  // discovery queue as a "Reporter" note; it NEVER auto-routes. The geoid is taken from the PATH
  // (authoritative) and injected into the body before validation. 404 when the geoid is unknown.
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

      if (!(await jurisdictionService().exists(geoid))) {
        throw AppError.notFound("Jurisdiction not found")
      }

      await writeAudit(container.getDb().sql, {
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
