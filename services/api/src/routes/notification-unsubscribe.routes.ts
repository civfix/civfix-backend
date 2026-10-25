import {
  AppError,
  ErrorCode,
  OpenUnsubscribeNotificationEmailRequestSchema,
  UnsubscribeNotificationEmailRequestSchema,
  type UnsubscribeNotificationEmailResponse,
} from "@civfix/contract"
import type { FastifyInstance } from "fastify"
import type { Container } from "../di.js"
import { exposeMessage } from "../errors/exposed-message.js"
import { webBaseUrlOf } from "../lib/base-url.js"
import { verifyNotificationEmailToken } from "../services/notification-email-token.js"
import { makeDrizzleNotificationSettingsRepository } from "../services/notification-settings-repository.drizzle.js"
import type { NotificationSettingsRepository } from "../services/notification-settings-repository.js"
import { route } from "../versioning/route.js"
import { tokenFrom, UNSUBSCRIBE_RATE_LIMIT } from "./host/unsubscribe.routes.js"

const NOTHING_APPLIED: UnsubscribeNotificationEmailResponse = { ok: true, category: null }

const UNSUBSCRIBE_UNAVAILABLE_COPY = "We couldn't save your unsubscribe. Please try again."

// D10's "Stop these emails": public, because the signed token rather than a session is the capability,
// and exempt from CSRF for the same reason (RFC 8058 one-click senders carry no cookie or header).
export async function registerNotificationUnsubscribeRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  function settingsRepo(): NotificationSettingsRepository {
    return (
      app.notificationOverrides?.settingsRepo ??
      makeDrizzleNotificationSettingsRepository(container.getDb().sql)
    )
  }

  function pageUrl(): string {
    return `${webBaseUrlOf(container.env)}/unsubscribe/notifications/`
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
      "unsubscribeNotificationEmail",
      { config: { rateLimit: UNSUBSCRIBE_RATE_LIMIT } },
      async (request, reply) => {
        const token = tokenFrom(request)
        const parsed =
          token !== null ? UnsubscribeNotificationEmailRequestSchema.safeParse({ token }) : null
        const capability =
          parsed?.success === true
            ? verifyNotificationEmailToken(
                parsed.data.token,
                container.env.UNSUBSCRIBE_SIGNING_KEY,
                Date.now(),
              )
            : null
        if (capability === null) {
          reply.status(200).send(NOTHING_APPLIED)
          return
        }
        let applied: boolean
        try {
          applied = await settingsRepo().disableEmail(capability.userId, capability.category)
        } catch (err) {
          // Only a verified token reaches the write. A 5xx is the retry signal for RFC 8058 one-click
          // senders, where a 200 would drop the opt-out for good.
          throw exposeMessage(
            new AppError(ErrorCode.INTERNAL, UNSUBSCRIBE_UNAVAILABLE_COPY, {
              httpStatus: 503,
              cause: err,
            }),
          )
        }
        const response: UnsubscribeNotificationEmailResponse = applied
          ? { ok: true, category: capability.category }
          : NOTHING_APPLIED
        reply.status(200).send(response)
      },
    )

    // A mail client or link scanner may open this link unasked, so it only hands the token to the page,
    // which posts it when the reader confirms.
    route(
      unsubscribeScope,
      "openUnsubscribeNotificationEmail",
      { config: { rateLimit: UNSUBSCRIBE_RATE_LIMIT } },
      async (request, reply) => {
        const query = (request.query ?? {}) as Record<string, unknown>
        const parsed = OpenUnsubscribeNotificationEmailRequestSchema.safeParse({ t: query.t })
        const target = parsed.success
          ? `${pageUrl()}?t=${encodeURIComponent(parsed.data.t)}`
          : pageUrl()
        reply.redirect(target, 302)
      },
    )
  })
}
