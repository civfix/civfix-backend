import {
  AppError,
  CreateDonationCheckoutRequestSchema,
  type CreateDonationCheckoutResponse,
  type GetDonationStatusResponse,
  type GetMyDonationReceiptResponse,
  type GetPublicOrgDonationPageResponse,
  type ListMyDonationsResponse,
} from "@civfix/shared"
import { z } from "zod"
import type { FastifyInstance, FastifyRequest, onRequestAsyncHookHandler } from "fastify"
import { applyRateLimitHeaders, perHost, perIdentity } from "../plugins/rate-limit.js"
import { normalizeIp } from "../abuse/ip-rate-limit.js"
import type { Container } from "../di.js"
import { requireAuth } from "../auth/context.js"
import { route } from "../versioning/route.js"
import { parse } from "./_validate.js"
import {
  makeDrizzleOrgPaymentsRepository,
  type OrgPaymentsRepository,
} from "../services/payments/org-payments-repository.drizzle.js"
import {
  makeDrizzleDonationRepository,
  type DonationRepository,
} from "../services/payments/donation-repository.drizzle.js"
import {
  makeDonationService,
  type DonationService,
  type DonationStorage,
} from "../services/payments/donation-service.js"

export const DONATE_PAGE_RATE_LIMIT = perHost({ max: 120, timeWindow: "1 minute" })
export const DONATION_CHECKOUT_RATE_LIMIT = perIdentity({
  max: 20,
  timeWindow: "1 hour",
  hostMax: 60,
})

export const DONATION_CHECKOUT_BURST_MAX = 10
export const DONATION_CHECKOUT_BURST_WINDOW = "1 minute"
export const DONATION_STATUS_RATE_LIMIT = perHost({ max: 60, timeWindow: "1 minute" })
export const MY_DONATIONS_RATE_LIMIT = perIdentity({ max: 60, timeWindow: "1 minute" })

export const DONATION_ORG_HOURLY_CAP = 200
export const MY_DONATIONS_PAGE_DEFAULT = 25
export const MY_DONATIONS_PAGE_MAX = 50

const SlugParamsSchema = z.object({ slug: z.string().min(3).max(40) }).strict()
const IdParamsSchema = z.object({ id: z.string().uuid() }).strict()
const StatusQuerySchema = z
  .object({
    token: z.string().min(16).max(512).optional(),
    sessionId: z.string().min(1).max(255).optional(),
    session_id: z.string().min(1).max(255).optional(),
  })
  .strip()
const DonatePageQuerySchema = z.object({ eventId: z.string().uuid().optional() }).strip()
const MyDonationsQuerySchema = z
  .object({
    cursor: z.string().max(512).optional(),
    limit: z.coerce.number().int().positive().max(MY_DONATIONS_PAGE_MAX).optional(),
  })
  .strict()

export interface DonationOverrides {
  donations?: DonationRepository
  orgs?: OrgPaymentsRepository
  storage?: DonationStorage
  now?: () => Date
  newId?: () => string
}

declare module "fastify" {
  interface FastifyInstance {
    donationOverrides?: DonationOverrides
  }
}

export async function registerDonationRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  const env = container.env
  const webOrigin = container.env.WEB_ORIGINS[0] ?? "https://civfix.org"

  function service(): DonationService {
    const overrides = app.donationOverrides
    return makeDonationService({
      donations: overrides?.donations ?? makeDrizzleDonationRepository(container.getDb().sql),
      orgs: overrides?.orgs ?? makeDrizzleOrgPaymentsRepository(container.getDb().sql),
      payments: container.payments,
      jobs: container.jobs,
      storage: overrides?.storage ?? container.storage,
      env: {
        PAYMENTS_ENABLED: env.PAYMENTS_ENABLED,
        DONATION_PLATFORM_FEE_BPS: env.DONATION_PLATFORM_FEE_BPS,
        DONATION_MIN_MINOR: env.DONATION_MIN_MINOR,
        DONATION_MAX_MINOR: env.DONATION_MAX_MINOR,
        DONATION_STATUS_TOKEN_KEY: env.DONATION_STATUS_TOKEN_KEY,
        ELIGIBILITY_STALE_GRACE_HOURS: env.ELIGIBILITY_STALE_GRACE_HOURS,
        PUBLIC_WEB_ORIGIN: webOrigin,
        ...(env.CA_CFP_REGISTRATION_NUMBER !== undefined
          ? { CA_CFP_REGISTRATION_NUMBER: env.CA_CFP_REGISTRATION_NUMBER }
          : {}),
      },
      ...(overrides?.now !== undefined ? { now: overrides.now } : {}),
      ...(overrides?.newId !== undefined ? { newId: overrides.newId } : {}),
      logger: app.log,
    })
  }

  const checkCheckoutBurst = app.createRateLimit({
    max: DONATION_CHECKOUT_BURST_MAX,
    timeWindow: DONATION_CHECKOUT_BURST_WINDOW,
    keyGenerator: (req) => `donate-burst:ip:${normalizeIp(req.ip)}`,
    allowList: () => false,
    skipOnError: false,
  })

  const checkoutBurstHook: onRequestAsyncHookHandler = async (req, reply) => {
    let result: Awaited<ReturnType<typeof checkCheckoutBurst>>
    try {
      result = await checkCheckoutBurst(req)
    } catch (err) {
      req.log.error({ err }, "donation checkout: burst limiter store error (fail closed)")
      throw AppError.rateLimited("Donations are temporarily unavailable; please try again shortly.")
    }
    if (!result.isAllowed && result.isExceeded) {
      applyRateLimitHeaders(reply, result)
      throw AppError.rateLimited()
    }
  }

  async function assertOrgCap(request: FastifyRequest, orgSlug: string): Promise<void> {
    const bucket = `donate:org:${orgSlug}:${Math.floor(Date.now() / 3600_000)}`
    let count: number
    try {
      count = await container.getCounterStore().incr(bucket, 3600)
    } catch (err) {
      request.log.error({ err, orgSlug }, "donation checkout: counter store unavailable (fail closed)")
      throw AppError.rateLimited("Donations are temporarily unavailable; please try again shortly.")
    }
    if (count > DONATION_ORG_HOURLY_CAP) {
      request.log.warn({ orgSlug, count }, "donation checkout: organization hourly cap exceeded")
      throw AppError.rateLimited()
    }
  }

  route(
    app,
    "getPublicOrgDonationPage",
    { config: { rateLimit: DONATE_PAGE_RATE_LIMIT } },
    async (request, reply) => {
      const { slug } = parse(SlugParamsSchema, request.params)
      const query = parse(DonatePageQuerySchema, request.query ?? {})
      const payload: GetPublicOrgDonationPageResponse = await service().publicPage(
        slug.toLowerCase(),
        query.eventId,
      )
      reply.header("cache-control", "no-store").status(200).send(payload)
    },
  )

  route(
    app,
    "createDonationCheckout",
    { onRequest: checkoutBurstHook, config: { rateLimit: DONATION_CHECKOUT_RATE_LIMIT } },
    async (request, reply) => {
      const body = parse(CreateDonationCheckoutRequestSchema, request.body ?? {})
      const userId = request.auth?.userId ?? null

      async function assertHumanAndUnderOrgCap(): Promise<void> {
        if (userId === null) {
          const token = body.turnstileToken
          if (token === undefined) throw AppError.turnstileFailed()
          const ok = await container.abuseChecks.verifyTurnstile(token, request.ip, {
            action: "donate",
          })
          if (!ok) throw AppError.turnstileFailed()
        }
        await assertOrgCap(request, body.orgSlug)
      }

      const payload: CreateDonationCheckoutResponse = await service().createCheckout({
        beforeAuthorize: assertHumanAndUnderOrgCap,
        orgSlug: body.orgSlug,
        amountMinor: body.amountMinor,
        email: body.email,
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.eventId !== undefined ? { eventId: body.eventId } : {}),
        shareIdentity: body.shareIdentity,
        idempotencyKey: body.idempotencyKey,
        userId,
        consent: body.consent,
      })
      reply.header("cache-control", "no-store").status(200).send(payload)
    },
  )

  route(
    app,
    "getDonationStatus",
    { config: { rateLimit: DONATION_STATUS_RATE_LIMIT } },
    async (request, reply) => {
      const { id } = parse(IdParamsSchema, request.params)
      const query = parse(StatusQuerySchema, request.query ?? {})
      const payload: GetDonationStatusResponse = await service().status({
        donationId: id,
        ...(query.token !== undefined ? { token: query.token } : {}),
        userId: request.auth?.userId ?? null,
      })
      reply.header("cache-control", "no-store").status(200).send(payload)
    },
  )

  route(
    app,
    "listMyDonations",
    { config: { rateLimit: MY_DONATIONS_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const query = parse(MyDonationsQuerySchema, request.query ?? {})
      const payload: ListMyDonationsResponse = await service().listMine({
        userId,
        ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
        limit: query.limit ?? MY_DONATIONS_PAGE_DEFAULT,
      })
      reply.status(200).send(payload)
    },
  )

  route(
    app,
    "getMyDonationReceipt",
    { config: { rateLimit: MY_DONATIONS_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { id } = parse(IdParamsSchema, request.params)
      const payload: GetMyDonationReceiptResponse = await service().receiptUrl({
        donationId: id,
        userId,
      })
      reply.header("cache-control", "no-store").status(200).send(payload)
    },
  )
}
