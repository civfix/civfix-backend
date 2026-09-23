import {
  ResolveAddressRequestSchema,
  ResolveJurisdictionRequestSchema,
  ReverseLabelRequestSchema,
  SuggestPlacesRequestSchema,
  ListCleanupsInBBoxRequestSchema,
  SuggestContactRequestSchema,
  AppError,
  type TileInfoResponse,
  type JurisdictionDTO,
  type ResolveAddressResponse,
  type ReverseLabelResponse,
  type SuggestPlacesResponse,
  type MapCleanupsResponse,
  type SuggestContactResponse,
} from "@civfix/shared"
import { suggestAddresses } from "@civfix/shared/geocode"
import { z } from "zod"
import type { FastifyInstance } from "fastify"
import type { Container } from "../di.js"
import {
  makeCachedAddressResolver,
  makeRouteJurisdictionService,
} from "../services/route-geo-helpers.js"
import { makeCleanupMapRepository, MAP_CLEANUPS_LIMIT } from "../services/cleanup-map-repository.js"
import { writeAudit } from "../services/admin/audit.js"
import { CappedBBoxQueryParam } from "./query-encoding.js"
import { parse, trimTextFields } from "./_validate.js"
import { route } from "../versioning/route.js"

export { MAP_CLEANUPS_LIMIT }

export const CARTO_VOYAGER_RASTER_URL =
  "https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png"

const CleanupsQuerySchema = z.object({
  bbox: CappedBBoxQueryParam,
  when: z.enum(["upcoming", "past"]).optional(),
})

const GeoidParamsSchema = z.object({ geoid: z.string().min(1) }).strict()

export const SuggestPlacesBodySchema = trimTextFields(SuggestPlacesRequestSchema, "q")

const SUGGEST_CONTACT_RATE_LIMIT = { max: 10, timeWindow: "1 minute" } as const

export const GEOCODER_RATE_LIMIT = { max: 30, timeWindow: "1 minute" } as const

const MAP_CLEANUPS_RATE_LIMIT = { max: 60, timeWindow: "1 minute" } as const

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
  function jurisdictionService() {
    return makeRouteJurisdictionService(container, { cacheLookup: true })
  }

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

  /**
   * The street-level preview the creation flows call once a pin settles. `reverseLabel` above stays
   * exactly as it is for already-deployed clients — it answers only TIGER's "City, ST", which is why
   * pin previews were vague; this one walks the whole ladder and says which rung it reached, so the UI
   * can prefill a confirmed address (street/intersection/landmark) or ask the host to type one
   * (locality/null) without ever guessing. `cityStateLabel` is populated either way as the hint line.
   *
   * Same rate-limit bucket as the other geocoder surfaces, and the read-through cache means a dragged
   * pin and the create that follows it share one provider call.
   */
  route(
    app,
    "resolveAddress",
    { config: { rateLimit: GEOCODER_RATE_LIMIT } },
    async (request, reply) => {
      const { lat, lng } = parse(ResolveAddressRequestSchema, request.body)
      const resolved = await makeCachedAddressResolver(container)(lat, lng)
      const payload: ResolveAddressResponse = {
        address: resolved.address,
        precision: resolved.precision,
        cityStateLabel: resolved.cityStateLabel,
      }
      reply.status(200).send(payload)
    },
  )

  route(app, "suggest", { config: { rateLimit: GEOCODER_RATE_LIMIT } }, async (request, reply) => {
    const { q, proximity, proximityZoom, limit, language } = parse(
      SuggestPlacesBodySchema,
      request.body,
    )
    const suggestions = await suggestAddresses(q, {
      ...(proximity ? { proximity } : {}),
      ...(proximityZoom != null ? { proximityZoom } : {}),
      ...(limit != null ? { limit } : {}),
      ...(language ? { language } : {}),
      ...(container.env.MAPBOX_TOKEN ? { mapboxToken: container.env.MAPBOX_TOKEN } : {}),
    })
    const payload: SuggestPlacesResponse = { suggestions }
    reply.status(200).send(payload)
  })

  route(
    app,
    "mapCleanups",
    {
      schema: { response: { 200: MapCleanupsResponseJsonSchema } },
      config: { rateLimit: MAP_CLEANUPS_RATE_LIMIT },
    },
    async (request, reply) => {
      const q = parse(CleanupsQuerySchema, request.query)
      const { bbox, when } = parse(ListCleanupsInBBoxRequestSchema, {
        bbox: q.bbox,
        ...(q.when !== undefined ? { when: q.when } : {}),
      })

      const repo = makeCleanupMapRepository(container.getDb().sql)
      const pins = await repo.listCleanupPins(bbox, when)
      const payload: MapCleanupsResponse = { pins }
      reply.header("Cache-Control", "public, max-age=60")
      reply.status(200).send(payload)
    },
  )

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
