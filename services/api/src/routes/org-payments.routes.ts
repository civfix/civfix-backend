import {
  AcceptOrgDonationAgreementRequestSchema,
  CreateOrgStripeAccountLinkRequestSchema,
  RequestOrgDonationExportRequestSchema,
  UpdateOrgDonationSettingsRequestSchema,
  type AcceptOrgDonationAgreementResponse,
  type CreateOrgStripeAccountLinkResponse,
  type CreateOrgStripeAccountResponse,
  type GetOrgDonationSettingsResponse,
  type GetOrgPaymentsStatusResponse,
  type GetOrgDonationSummaryResponse,
  type ListOrgDonationsResponse,
  type RequestOrgDonationExportResponse,
  type UpdateOrgDonationSettingsResponse,
} from "@civfix/shared"
import { z } from "zod"
import type { FastifyInstance } from "fastify"
import { perIdentity } from "../plugins/rate-limit.js"
import type { Container } from "../di.js"
import { requireAuth } from "../auth/context.js"
import { requireOrgCapability } from "../services/host/authz.js"
import { route } from "../versioning/route.js"
import { parse } from "./_validate.js"
import { makeDrizzleOrgPaymentsRepository } from "../services/payments/org-payments-repository.drizzle.js"
import type { OrgPaymentsRepository } from "../services/payments/org-payments-repository.drizzle.js"
import {
  makeDrizzleDonationRepository,
  type DonationRepository,
} from "../services/payments/donation-repository.drizzle.js"
import {
  makeOrgPaymentsService,
  type OrgPaymentsService,
} from "../services/payments/org-payments-service.js"
import {
  makeDonationService,
  type DonationService,
  type DonationStorage,
} from "../services/payments/donation-service.js"
import { makeCommsRuntime } from "../services/host/comms-wiring.js"
import type { HostExportService } from "../services/host/export-service.js"

export const ORG_ACCOUNT_RATE_LIMIT = perIdentity({ max: 5, timeWindow: "1 day" })
export const ORG_ACCOUNT_LINK_RATE_LIMIT = perIdentity({ max: 20, timeWindow: "1 day" })
export const ORG_PAYMENTS_READ_RATE_LIMIT = perIdentity({ max: 60, timeWindow: "1 minute" })
export const ORG_SETTINGS_WRITE_RATE_LIMIT = perIdentity({ max: 30, timeWindow: "1 day" })
export const ORG_DONATION_EXPORT_RATE_LIMIT = perIdentity({ max: 10, timeWindow: "1 day" })

export const ORG_DONATIONS_PAGE_DEFAULT = 25
export const ORG_DONATIONS_PAGE_MAX = 50

const IdParamsSchema = z.object({ id: z.string().uuid() }).strict()

const ListQuerySchema = z
  .object({
    cursor: z.string().max(512).optional(),
    limit: z.coerce.number().int().positive().max(ORG_DONATIONS_PAGE_MAX).optional(),
    status: z
      .enum(["pending", "succeeded", "failed", "refunded", "partially_refunded"])
      .optional(),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
  })
  .strict()

const SummaryQuerySchema = z
  .object({ from: z.string().datetime().optional(), to: z.string().datetime().optional() })
  .strict()

export interface OrgPaymentsOverrides {
  orgs?: OrgPaymentsRepository
  donations?: DonationRepository
  storage?: DonationStorage
  exports?: Pick<HostExportService, "request">
  now?: () => Date
}

declare module "fastify" {
  interface FastifyInstance {
    orgPaymentsOverrides?: OrgPaymentsOverrides
  }
}

export async function registerOrgPaymentsRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  const csrfProtect = container.csrf.protect
  const env = container.env
  const webOrigin = container.env.WEB_ORIGINS[0] ?? "https://civfix.org"

  function orgRepo(): OrgPaymentsRepository {
    return app.orgPaymentsOverrides?.orgs ?? makeDrizzleOrgPaymentsRepository(container.getDb().sql)
  }

  function donationRepo(): DonationRepository {
    return (
      app.orgPaymentsOverrides?.donations ?? makeDrizzleDonationRepository(container.getDb().sql)
    )
  }

  function service(): OrgPaymentsService {
    return makeOrgPaymentsService({
      repo: orgRepo(),
      payments: container.payments,
      jobs: container.jobs,
      env: {
        PAYMENTS_ENABLED: env.PAYMENTS_ENABLED,
        DONATION_PLATFORM_FEE_BPS: env.DONATION_PLATFORM_FEE_BPS,
        DONATION_MIN_MINOR: env.DONATION_MIN_MINOR,
        DONATION_MAX_MINOR: env.DONATION_MAX_MINOR,
        PAYMENT_METHOD_DOMAINS: env.PAYMENT_METHOD_DOMAINS,
        PUBLIC_WEB_ORIGIN: webOrigin,
      },
      ...(app.orgPaymentsOverrides?.now !== undefined ? { now: app.orgPaymentsOverrides.now } : {}),
      logger: app.log,
    })
  }

  function donations(): DonationService {
    return makeDonationService({
      donations: donationRepo(),
      orgs: orgRepo(),
      payments: container.payments,
      jobs: container.jobs,
      storage: app.orgPaymentsOverrides?.storage ?? container.storage,
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
      ...(app.orgPaymentsOverrides?.now !== undefined ? { now: app.orgPaymentsOverrides.now } : {}),
      logger: app.log,
    })
  }

  async function requireManagePayments(
    organizationId: string,
    userId: string,
  ): Promise<void> {
    await requireOrgCapability(container.getDb().sql, organizationId, userId, "manage_payments")
  }

  async function requireViewDonations(organizationId: string, userId: string): Promise<void> {
    await requireOrgCapability(container.getDb().sql, organizationId, userId, "view_donations")
  }

  route(
    app,
    "createOrgStripeAccount",
    { preHandler: csrfProtect, config: { rateLimit: ORG_ACCOUNT_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { id } = parse(IdParamsSchema, request.params)
      await requireManagePayments(id, userId)
      const payload: CreateOrgStripeAccountResponse = await service().createAccount(id, userId)
      reply.status(200).send(payload)
    },
  )

  route(
    app,
    "createOrgStripeAccountLink",
    { preHandler: csrfProtect, config: { rateLimit: ORG_ACCOUNT_LINK_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { id } = parse(IdParamsSchema, request.params)
      await requireManagePayments(id, userId)
      const body = parse(CreateOrgStripeAccountLinkRequestSchema, {
        ...((request.body as object | undefined) ?? {}),
        id,
      })
      const payload: CreateOrgStripeAccountLinkResponse = await service().createAccountLink(
        id,
        body.type,
      )
      reply.header("cache-control", "no-store").status(200).send(payload)
    },
  )

  route(
    app,
    "getOrgPaymentsStatus",
    { config: { rateLimit: ORG_PAYMENTS_READ_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { id } = parse(IdParamsSchema, request.params)
      await requireViewDonations(id, userId)
      const payload: GetOrgPaymentsStatusResponse = await service().status(id)
      reply.status(200).send(payload)
    },
  )

  route(
    app,
    "getOrgDonationSettings",
    { config: { rateLimit: ORG_PAYMENTS_READ_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { id } = parse(IdParamsSchema, request.params)
      await requireViewDonations(id, userId)
      const payload: GetOrgDonationSettingsResponse = await service().settings(id)
      reply.status(200).send(payload)
    },
  )

  route(
    app,
    "updateOrgDonationSettings",
    { preHandler: csrfProtect, config: { rateLimit: ORG_SETTINGS_WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { id } = parse(IdParamsSchema, request.params)
      await requireManagePayments(id, userId)
      const body = parse(UpdateOrgDonationSettingsRequestSchema, {
        ...((request.body as object | undefined) ?? {}),
        id,
      })
      const payload: UpdateOrgDonationSettingsResponse = await service().updateSettings({
        organizationId: id,
        userId,
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        ...(body.donorSharingDefault !== undefined
          ? { donorSharingDefault: body.donorSharingDefault }
          : {}),
        ...(body.missionBlurb !== undefined ? { missionBlurb: body.missionBlurb } : {}),
        ...(body.designationNote !== undefined ? { designationNote: body.designationNote } : {}),
        ...(body.refundPolicyText !== undefined ? { refundPolicyText: body.refundPolicyText } : {}),
        ...(body.minAmountMinor !== undefined ? { minAmountMinor: body.minAmountMinor } : {}),
        ...(body.maxAmountMinor !== undefined ? { maxAmountMinor: body.maxAmountMinor } : {}),
        ...(body.suggestedAmountsMinor !== undefined
          ? { suggestedAmountsMinor: body.suggestedAmountsMinor }
          : {}),
      })
      reply.status(200).send(payload)
    },
  )

  route(
    app,
    "acceptOrgDonationAgreement",
    { preHandler: csrfProtect, config: { rateLimit: ORG_SETTINGS_WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { id } = parse(IdParamsSchema, request.params)
      await requireManagePayments(id, userId)
      const body = parse(AcceptOrgDonationAgreementRequestSchema, {
        ...((request.body as object | undefined) ?? {}),
        id,
      })
      const agreement = await service().acceptAgreement({
        organizationId: id,
        userId,
        version: body.version,
        ...(body.documentSha256 !== undefined ? { documentSha256: body.documentSha256 } : {}),
        surface: body.surface,
        ...(body.screenRoute !== undefined ? { screenRoute: body.screenRoute } : {}),
        ...(body.uiTemplateVersion !== undefined
          ? { uiTemplateVersion: body.uiTemplateVersion }
          : {}),
      })
      const payload: AcceptOrgDonationAgreementResponse = { ok: true, agreement }
      reply.status(200).send(payload)
    },
  )

  route(
    app,
    "listOrgDonations",
    { config: { rateLimit: ORG_PAYMENTS_READ_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { id } = parse(IdParamsSchema, request.params)
      await requireViewDonations(id, userId)
      const query = parse(ListQuerySchema, request.query ?? {})
      const payload: ListOrgDonationsResponse = await donations().listForOrg({
        organizationId: id,
        ...(query.status !== undefined ? { status: query.status } : {}),
        ...(query.from !== undefined ? { from: new Date(query.from) } : {}),
        ...(query.to !== undefined ? { to: new Date(query.to) } : {}),
        ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
        limit: query.limit ?? ORG_DONATIONS_PAGE_DEFAULT,
      })
      reply.status(200).send(payload)
    },
  )

  route(
    app,
    "getOrgDonationSummary",
    { config: { rateLimit: ORG_PAYMENTS_READ_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { id } = parse(IdParamsSchema, request.params)
      await requireViewDonations(id, userId)
      const query = parse(SummaryQuerySchema, request.query ?? {})
      const payload: GetOrgDonationSummaryResponse = await donations().summaryForOrg({
        organizationId: id,
        ...(query.from !== undefined ? { from: new Date(query.from) } : {}),
        ...(query.to !== undefined ? { to: new Date(query.to) } : {}),
      })
      reply.status(200).send(payload)
    },
  )

  route(
    app,
    "requestOrgDonationExport",
    { preHandler: csrfProtect, config: { rateLimit: ORG_DONATION_EXPORT_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { id } = parse(IdParamsSchema, request.params)
      await requireViewDonations(id, userId)
      const exports = app.orgPaymentsOverrides?.exports ?? makeCommsRuntime(container, app.log).exports
      const body = parse(RequestOrgDonationExportRequestSchema, {
        ...((request.body as object | undefined) ?? {}),
        id,
      })
      const payload: RequestOrgDonationExportResponse = await exports.request({
        kind: "donations",
        organizationId: id,
        cleanupId: null,
        requestedBy: userId,
        filters: body.filters ?? {},
      })
      reply.status(200).send(payload)
    },
  )
}
