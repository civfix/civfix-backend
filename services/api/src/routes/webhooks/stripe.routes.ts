import type { Payments, PaymentsWebhookEvent, PaymentsWebhookScope } from "@civfix/shared/interfaces"
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { perHost } from "../../plugins/rate-limit.js"
import type { Container } from "../../di.js"
import {
  makeDrizzleStripeEventRepository,
  type StripeEventRepository,
} from "../../services/payments/donation-repository.drizzle.js"
import {
  PAYMENTS_JOB_RETRY_LIMIT,
  STRIPE_EVENT_PROCESS_JOB,
} from "../../services/payments/payments-queues.js"

export const STRIPE_WEBHOOK_CONNECT_PATH = "/webhooks/stripe/connect"

export const STRIPE_WEBHOOK_PLATFORM_PATH = "/webhooks/stripe/platform"

export const STRIPE_SIGNATURE_HEADER = "stripe-signature"

export const STRIPE_WEBHOOK_BODY_LIMIT = 1024 * 1024

export const STRIPE_EVENT_RETENTION_DAYS = 400

export const STRIPE_WEBHOOK_RATE_LIMIT = perHost({
  max: 600,
  timeWindow: "1 minute",
  skipOnError: true,
})

export interface StripeWebhookOverrides {
  events?: StripeEventRepository
  now?: () => Date
}

declare module "fastify" {
  interface FastifyInstance {
    stripeWebhookOverrides?: StripeWebhookOverrides
  }
}

export type ScopeInvariantResult = "ok" | "connect_without_account" | "platform_with_account"

export function checkScopeInvariant(event: PaymentsWebhookEvent): ScopeInvariantResult {
  if (event.scope === "connect" && event.accountId === null) return "connect_without_account"
  if (event.scope === "platform" && event.accountId !== null) return "platform_with_account"
  return "ok"
}

function objectIdOf(event: PaymentsWebhookEvent): string | null {
  const id = event.data.object.id
  return typeof id === "string" ? id : null
}

export function isWebhookSignatureError(err: unknown): boolean {
  return (
    typeof err === "object" && err !== null && (err as { name?: unknown }).name === "WebhookSignatureError"
  )
}

function rawBodyOf(request: FastifyRequest): Buffer | null {
  return request.body instanceof Buffer ? request.body : null
}

function signatureOf(request: FastifyRequest): string | null {
  const header = request.headers[STRIPE_SIGNATURE_HEADER]
  const presented = Array.isArray(header) ? header[0] : header
  return typeof presented === "string" && presented.length > 0 ? presented : null
}

export async function registerStripeWebhooks(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  const env = container.env
  if (!env.PAYMENTS_ENABLED) return

  const payments = container.payments

  await app.register(async (scope) => {
    scope.addContentTypeParser(
      "application/json",
      { parseAs: "buffer" },
      (_req: FastifyRequest, payload: Buffer, done: (err: Error | null, body?: unknown) => void) => {
        done(null, payload)
      },
    )

    for (const [path, webhookScope] of [
      [STRIPE_WEBHOOK_CONNECT_PATH, "connect"],
      [STRIPE_WEBHOOK_PLATFORM_PATH, "platform"],
    ] as const) {
      scope.post(
        path,
        {
          bodyLimit: STRIPE_WEBHOOK_BODY_LIMIT,
          config: { rateLimit: STRIPE_WEBHOOK_RATE_LIMIT },
        },
        async (request, reply) => {
          await handleStripeWebhook(request, reply, container, app, webhookScope, payments)
        },
      )
    }
  })
}

async function handleStripeWebhook(
  request: FastifyRequest,
  reply: FastifyReply,
  container: Container,
  app: FastifyInstance,
  scope: PaymentsWebhookScope,
  payments: Payments,
): Promise<void> {
  const raw = rawBodyOf(request)
  const signature = signatureOf(request)
  if (raw === null || signature === null) {
    reply.status(400).send()
    return
  }

  let event: PaymentsWebhookEvent
  try {
    event = payments.verifyWebhookSignature(raw, signature, scope)
  } catch (err) {
    if (!isWebhookSignatureError(err)) {
      request.log.error({ scope }, "stripe webhook: signature verification failed unexpectedly")
    }
    reply.status(400).send()
    return
  }

  const overrides = app.stripeWebhookOverrides
  const now = overrides?.now ?? (() => new Date())
  const expectedLivemode = payments.mode() === "live"

  if (event.livemode !== expectedLivemode) {
    request.log.warn(
      { scope, eventType: event.type, livemode: event.livemode },
      "stripe webhook: livemode mismatch (acknowledged, not stored)",
    )
    reply.status(200).send({ received: true })
    return
  }

  const invariant = checkScopeInvariant(event)
  if (invariant !== "ok") {
    request.log.warn(
      { scope, eventType: event.type, invariant },
      "stripe webhook: scope invariant violated (acknowledged, skipped)",
    )
    reply.status(200).send({ received: true })
    return
  }

  const events = overrides?.events ?? makeDrizzleStripeEventRepository(container.getDb().sql)
  const retentionUntil = new Date(now().getTime() + STRIPE_EVENT_RETENTION_DAYS * 86400_000)

  const inserted = await events.insert({
    id: event.id,
    scope,
    type: event.type,
    accountId: event.accountId,
    objectId: objectIdOf(event),
    livemode: event.livemode,
    apiVersion: event.apiVersion,
    payload: event as unknown as Record<string, unknown>,
    retentionUntil,
  })

  if (!inserted) {
    reply.status(200).send({ received: true, duplicate: true })
    return
  }

  reply.status(200).send({ received: true })

  await container.jobs
    .enqueue(
      STRIPE_EVENT_PROCESS_JOB,
      { eventId: event.id },
      { singletonKey: `stripe-event:${event.id}`, retryLimit: PAYMENTS_JOB_RETRY_LIMIT },
    )
    .catch((err: unknown) => {
      request.log.warn(
        { err, eventId: event.id },
        "stripe webhook: enqueue failed; the sweep will re-enqueue this event",
      )
    })
}
