import { RecordEventPageViewRequestSchema } from "@civfix/shared"
import type { FastifyInstance, FastifyRequest } from "fastify"
import type { Container } from "../../di.js"
import { perHost } from "../../plugins/rate-limit.js"
import { route } from "../../versioning/route.js"
import { parse } from "../_validate.js"
import { makeCommsRuntime } from "../../services/host/comms-wiring.js"
import type { CommsRuntime } from "../../services/host/comms-wiring.js"

const ONE_MINUTE = "1 minute"

export const PAGE_VIEW_RATE_LIMIT = perHost({ max: 120, timeWindow: ONE_MINUTE })

function headerOf(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name]
  if (typeof value === "string") return value
  return Array.isArray(value) ? value[0] : undefined
}

export async function registerPageViewRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  let cached: CommsRuntime | undefined

  function runtime(): CommsRuntime {
    const override = app.broadcastOverrides
    if (override) return override.runtime
    return (cached ??= makeCommsRuntime(container, app.log))
  }

  route(
    app,
    "recordEventPageView",
    { config: { rateLimit: PAGE_VIEW_RATE_LIMIT } },
    async (request, reply) => {
      const params = (request.params ?? {}) as Record<string, unknown>
      const body = (request.body ?? {}) as Record<string, unknown>
      const input = parse(RecordEventPageViewRequestSchema, { ...body, ...params })
      const userAgent = headerOf(request, "user-agent")
      const referrer = headerOf(request, "referer") ?? headerOf(request, "referrer")
      try {
        await runtime().metrics.recordPageView({
          slug: input.slug,
          ...(input.source !== undefined ? { declaredSource: input.source } : {}),
          ...(input.utmSource !== undefined ? { utmSource: input.utmSource } : {}),
          ...(referrer !== undefined ? { referrer } : {}),
          ...(userAgent !== undefined ? { userAgent } : {}),
        })
      } catch (err) {
        // A view counter is analytics, not state the visitor depends on: the beacon never fails.
        request.log.warn({ err }, "page view: counter write failed (view not counted)")
      }
      reply.status(200).send({ ok: true })
    },
  )
}
