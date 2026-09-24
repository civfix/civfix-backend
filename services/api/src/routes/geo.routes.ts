import {
  GetApproximateLocationRequestSchema,
  type GetApproximateLocationResponse,
} from "@civfix/shared"
import type { FastifyInstance } from "fastify"
import type { Container } from "../di.js"
import { cfGeoFromTrustedEdge } from "../abuse/gps-sanity.js"
import { approximateLocationFor } from "../services/geo-approximate.js"
import { route } from "../versioning/route.js"
import { parse } from "./_validate.js"

const APPROXIMATE_LOCATION_RATE_LIMIT = { max: 60, timeWindow: "1 minute" } as const
const APPROXIMATE_LOCATION_CACHE_CONTROL = "private, max-age=300"

const ApproximateLocationResponseJsonSchema = {
  type: "object",
  properties: {
    lat: { type: "number" },
    lng: { type: "number" },
    radiusKm: { type: "number" },
    source: { type: "string", enum: ["ip", "region"] },
  },
  required: ["lat", "lng", "radiusKm", "source"],
} as const

export async function registerGeoRoutes(app: FastifyInstance, container: Container): Promise<void> {
  route(
    app,
    "getApproximateLocation",
    {
      schema: { response: { 200: ApproximateLocationResponseJsonSchema } },
      config: { rateLimit: APPROXIMATE_LOCATION_RATE_LIMIT },
    },
    async (request, reply) => {
      parse(GetApproximateLocationRequestSchema, request.query)

      const env = container.env
      const payload: GetApproximateLocationResponse = approximateLocationFor(
        { headers: request.headers, trusted: cfGeoFromTrustedEdge(request) },
        {
          lat: env.HOME_REGION_LAT,
          lng: env.HOME_REGION_LNG,
          radiusKm: env.HOME_REGION_RADIUS_KM,
        },
      )

      reply.header("Cache-Control", APPROXIMATE_LOCATION_CACHE_CONTROL)
      reply.status(200).send(payload)
    },
  )
}
