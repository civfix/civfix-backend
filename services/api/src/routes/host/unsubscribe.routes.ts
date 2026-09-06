import {
  OpenUnsubscribeBroadcastsRequestSchema,
  UnsubscribeBroadcastsRequestSchema,
  type UnsubscribeBroadcastsResponse,
} from "@civfix/shared"
import type { FastifyInstance, FastifyRequest } from "fastify"
import type { Container } from "../../di.js"
import { perHost } from "../../plugins/rate-limit.js"
import { route } from "../../versioning/route.js"
import { makeCommsRuntime, webBaseUrlOf } from "../../services/host/comms-wiring.js"
import type { CommsRuntime } from "../../services/host/comms-wiring.js"

export const UNSUBSCRIBE_RATE_LIMIT = perHost({ max: 60, timeWindow: "1 minute" })

const OK: UnsubscribeBroadcastsResponse = { ok: true }

function tokenFrom(request: FastifyRequest): string | null {
  const body = (request.body ?? {}) as Record<string, unknown>
  if (typeof body.token === "string" && body.token.length > 0) return body.token
  const query = (request.query ?? {}) as Record<string, unknown>
  if (typeof query.t === "string" && query.t.length > 0) return query.t
  return null
}

export async function registerUnsubscribeRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  let cached: CommsRuntime | undefined

  function runtime(): CommsRuntime {
    const override = app.broadcastOverrides
    if (override) return override.runtime
    return (cached ??= makeCommsRuntime(container, app.log))
  }

  function webBaseUrl(): string {
    return webBaseUrlOf(container.env?.WEB_ORIGINS ?? [])
  }

  await app.register(async (unsubscribeScope) => {
    unsubscribeScope.addContentTypeParser(
      "application/x-www-form-urlencoded",
      { parseAs: "string" },
      (_req, body, done) => {
        try {
          done(null, Object.fromEntries(new URLSearchParams(body as string)))
        } catch (err) {
          done(err as Error)
        }
      },
    )

    route(
      unsubscribeScope,
      "unsubscribeBroadcasts",
      { config: { rateLimit: UNSUBSCRIBE_RATE_LIMIT } },
      async (request, reply) => {
        const token = tokenFrom(request)
        if (token === null) {
          reply.status(200).send(OK)
          return
        }
        const parsed = UnsubscribeBroadcastsRequestSchema.safeParse({ token })
        if (!parsed.success) {
          reply.status(200).send(OK)
          return
        }
        try {
          await runtime().broadcasts.unsubscribe(parsed.data.token)
        } catch (err) {
          request.log.error({ err }, "unsubscribe: write failed (answering 200 regardless)")
        }
        reply.status(200).send(OK)
      },
    )

    route(
      unsubscribeScope,
      "openUnsubscribeBroadcasts",
      { config: { rateLimit: UNSUBSCRIBE_RATE_LIMIT } },
      async (request, reply) => {
        const query = (request.query ?? {}) as Record<string, unknown>
        const parsed = OpenUnsubscribeBroadcastsRequestSchema.safeParse({ t: query.t })
        const target = parsed.success
          ? `${webBaseUrl()}/unsubscribe?t=${encodeURIComponent(parsed.data.t)}`
          : `${webBaseUrl()}/unsubscribe`
        reply.redirect(target, 302)
      },
    )
  })

}
