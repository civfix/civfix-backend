
import { createHmac } from "node:crypto"
import { AppError } from "@civfix/shared"
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { perHost } from "../../plugins/rate-limit.js"
import type { Container } from "../../di.js"
import { constantTimeStringEqual } from "../../auth/crypto.js"
import {
  processInboundObject,
  INBOUND_PENDING_KEY_RE,
  type InboundProcessorDeps,
} from "../../services/admin/inbound-processor.js"

export const CF_WEBHOOK_SIGNATURE_HEADER = "x-cf-signature"

export const CF_WEBHOOK_TIMESTAMP_HEADER = "x-cf-timestamp"

export const WEBHOOK_MAX_CLOCK_SKEW_SEC = 5 * 60

export const ACCEPT_LEGACY_UNTIMESTAMPED_SIGNATURE = true

const LEGACY_WARN_INTERVAL_SEC = 300
let lastLegacyWarnAtSec = 0

export const INBOUND_WEBHOOK_RATE_LIMIT = perHost({ max: 60, timeWindow: "1 minute" })

const INBOUND_WEBHOOK_BODY_LIMIT = 4096

export type InboundMailWebhookOverrides = InboundProcessorDeps

declare module "fastify" {
  interface FastifyInstance {
    inboundMailOverrides?: InboundMailWebhookOverrides
  }
}

export async function registerInboundMailWebhook(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  const expectedSecret = container.env.CF_EMAIL_WEBHOOK_SECRET

  await app.register(async (scope) => {
    scope.addContentTypeParser(
      "application/json",
      { parseAs: "buffer" },
      (_req: FastifyRequest, payload: Buffer, done: (err: Error | null, body?: unknown) => void) => {
        done(null, payload)
      },
    )

    scope.post(
      "/webhooks/inbound-mail",
      { bodyLimit: INBOUND_WEBHOOK_BODY_LIMIT, config: { rateLimit: INBOUND_WEBHOOK_RATE_LIMIT } },
      async (request, reply) => {
        await handleInbound(request, reply, container, app, expectedSecret)
      },
    )
  })
}

async function handleInbound(
  request: FastifyRequest,
  reply: FastifyReply,
  container: Container,
  app: FastifyInstance,
  expectedSecret: string | undefined,
): Promise<void> {
  const rawBuf = request.body instanceof Buffer ? request.body : null
  assertSignature(request, rawBuf, expectedSecret)

  const key = readKey(rawBuf)
  if (key === null) return ack(reply, { processed: false, reason: "bad-key" })

  try {
    const deps: InboundProcessorDeps = {
      logger: request.log,
      ...(app.inboundMailOverrides ?? {}),
    }
    const result = await processInboundObject(container, key, deps)
    return ack(reply, { processed: result.outcome !== "skipped", outcome: result.outcome })
  } catch (err) {
    request.log.warn(
      { err, key },
      "inbound-mail webhook: processing failed (acked 202; sweep will retry)",
    )
    return ack(reply, { processed: false, reason: "error" })
  }
}

export function assertSignature(
  request: FastifyRequest,
  rawBuf: Buffer | null,
  expectedSecret: string | undefined,
  nowSec: number = Math.floor(Date.now() / 1000),
): void {
  if (!expectedSecret) {
    throw AppError.unauthorized("Inbound mail webhook is not configured.")
  }
  if (rawBuf === null) {
    throw AppError.unauthorized("Inbound mail webhook body missing.")
  }
  const header = request.headers[CF_WEBHOOK_SIGNATURE_HEADER]
  const presented = Array.isArray(header) ? header[0] : header
  if (!presented) {
    throw AppError.unauthorized("Invalid inbound mail webhook signature.")
  }

  const tsHeader = request.headers[CF_WEBHOOK_TIMESTAMP_HEADER]
  const rawTs = Array.isArray(tsHeader) ? tsHeader[0] : tsHeader

  if (rawTs !== undefined && rawTs !== "") {
    const ts = Number.parseInt(rawTs, 10)
    if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > WEBHOOK_MAX_CLOCK_SKEW_SEC) {
      throw AppError.unauthorized("Inbound mail webhook signature expired.")
    }
    const expected = createHmac("sha256", expectedSecret)
      .update(`${rawTs}.`)
      .update(rawBuf)
      .digest("hex")
    if (!constantTimeStringEqual(presented, expected)) {
      throw AppError.unauthorized("Invalid inbound mail webhook signature.")
    }
    return
  }

  if (!ACCEPT_LEGACY_UNTIMESTAMPED_SIGNATURE) {
    throw AppError.unauthorized("Inbound mail webhook signature is missing its timestamp.")
  }
  const nowSecForWarn = nowSec
  if (nowSecForWarn - lastLegacyWarnAtSec >= LEGACY_WARN_INTERVAL_SEC) {
    lastLegacyWarnAtSec = nowSecForWarn
    request.log.warn("inbound-mail webhook: legacy untimestamped signature accepted (replayable)")
  }
  const legacyExpected = createHmac("sha256", expectedSecret).update(rawBuf).digest("hex")
  if (!constantTimeStringEqual(presented, legacyExpected)) {
    throw AppError.unauthorized("Invalid inbound mail webhook signature.")
  }
}

function readKey(rawBuf: Buffer | null): string | null {
  if (rawBuf === null || rawBuf.byteLength === 0) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(rawBuf.toString("utf8"))
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null) return null
  const key = (parsed as { key?: unknown }).key
  if (typeof key !== "string" || !INBOUND_PENDING_KEY_RE.test(key)) return null
  return key
}

function ack(reply: FastifyReply, body: Record<string, unknown>): void {
  reply.status(202).send({ accepted: true, ...body })
}
