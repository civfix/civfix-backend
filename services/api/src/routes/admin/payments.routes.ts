import {
  AdminDonationListQuerySchema,
  AdminDonationTotalsByOrgQuerySchema,
  AdminPaymentsEligibilityListQuerySchema,
  ConfirmOrgCentralOrgRequestSchema,
  DONATION_CURRENCY,
  SetOrgDonationsEnabledRequestSchema,
  SetOrgEligibilityEinRequestSchema,
  type AdminDonationListResponse,
  type AdminDonationTotalsByOrgResponse,
  type AdminPaymentsEligibilityListResponse,
  type ConfirmOrgCentralOrgResponse,
  type EvaluateOrgEligibilityResponse,
  type GetAdminOrgPaymentsResponse,
  type GetAdminPlatformDonationSettingsResponse,
  type SetOrgDonationsEnabledResponse,
  type SetOrgEligibilityEinResponse,
} from "@civfix/shared"
import { REVIEW_REQUIRED_BLOCKS_DONATIONS } from "@civfix/shared/payments"
import { AppError } from "@civfix/shared"
import type { FastifyInstance } from "fastify"
import { isUuid } from "../../db/cursor-helpers.js"
import type { Container } from "../../di.js"
import { requireAuth } from "../../auth/context.js"
import { route } from "../../versioning/route.js"
import { writeAudit } from "../../services/admin/audit.js"
import { idParam, parse, parseBodyWithId } from "./_route-utils.js"
import {
  makeDrizzleOrgPaymentsRepository,
  type OrgPaymentsRepository,
} from "../../services/payments/org-payments-repository.drizzle.js"
import {
  makeDrizzleDonationRepository,
  encodeDonationCursor,
  type DonationRepository,
} from "../../services/payments/donation-repository.drizzle.js"
import {
  makeDrizzleEligibilityRepository,
  type EligibilityRepository,
} from "../../services/payments/eligibility-repository.drizzle.js"
import {
  makeEligibilityService,
  type EligibilityService,
} from "../../services/payments/eligibility-service.js"
import {
  makeOrgPaymentsService,
  MAX_AGREEMENT_HISTORY,
  MAX_ELIGIBILITY_CHECKS_SHOWN,
  einLast4,
} from "../../services/payments/org-payments-service.js"

export const ADMIN_DONATIONS_PAGE_DEFAULT = 50

export const ADMIN_DONATION_TOTALS_ORG_CAP = 500
export const ADMIN_ELIGIBILITY_PAGE_DEFAULT = 50

export interface AdminPaymentsOverrides {
  orgs?: OrgPaymentsRepository
  donations?: DonationRepository
  eligibility?: EligibilityRepository
  now?: () => Date
}

declare module "fastify" {
  interface FastifyInstance {
    adminPaymentsOverrides?: AdminPaymentsOverrides
  }
}

export async function registerAdminPaymentsRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  const csrfProtect = container.csrf.protect
  const env = container.env
  const webOrigin = container.env.WEB_ORIGINS[0] ?? "https://civfix.org"

  function orgRepo(): OrgPaymentsRepository {
    return (
      app.adminPaymentsOverrides?.orgs ?? makeDrizzleOrgPaymentsRepository(container.getDb().sql)
    )
  }
  function donationRepo(): DonationRepository {
    return (
      app.adminPaymentsOverrides?.donations ?? makeDrizzleDonationRepository(container.getDb().sql)
    )
  }
  function eligibilityRepo(): EligibilityRepository {
    return (
      app.adminPaymentsOverrides?.eligibility ??
      makeDrizzleEligibilityRepository(container.getDb().sql)
    )
  }
  function eligibilityService(): EligibilityService {
    return makeEligibilityService({
      eligibility: eligibilityRepo(),
      orgs: orgRepo(),
      storage: container.storage,
      ...(env.PAYMENTS_ENABLED ? { jobs: container.jobs } : {}),
      ...(app.adminPaymentsOverrides?.now !== undefined
        ? { now: app.adminPaymentsOverrides.now }
        : {}),
      logger: app.log,
    })
  }
  function filingLivemode(): boolean {
    return env.PAYMENTS_ENABLED ? container.payments.mode() === "live" : true
  }

  function service() {
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
      ...(app.adminPaymentsOverrides?.now !== undefined
        ? { now: app.adminPaymentsOverrides.now }
        : {}),
      logger: app.log,
    })
  }

  route(app, "adminGetOrgPayments", async (request, reply) => {
    const { id } = idParam(request)
    const repo = orgRepo()
    const view = await repo.paymentsView(id)
    if (view === null) throw AppError.notFound("Organization not found")

    const [status, history, totals] = await Promise.all([
      service().status(id),
      repo.agreementHistory(id, MAX_AGREEMENT_HISTORY),
      donationRepo().lifetimeTotals(id),
    ])

    const payload: GetAdminOrgPaymentsResponse = {
      organizationId: id,
      orgName: view.org.name,
      orgSlug: view.org.slug,
      status,
      agreementHistory: history.map((entry) => ({
        version: entry.version,
        acceptedAt: entry.acceptedAt.toISOString(),
        acceptedByName: entry.acceptedByName,
        surface: entry.surface,
      })),
      lifetimeGrossMinor: totals.grossMinor,
      lifetimeDonationCount: totals.count,
      disabledBy: view.settings?.disabledBy ?? null,
      disabledReasonText: view.settings?.disabledReasonText ?? null,
    }
    reply.status(200).send(payload)
  })

  route(app, "adminListPaymentsEligibility", async (request, reply) => {
    const query = parse(AdminPaymentsEligibilityListQuerySchema, request.query ?? {})
    if (query.cursor !== undefined && !isUuid(query.cursor)) {
      throw AppError.validation({ cursor: "is not a valid page cursor" })
    }
    const limit = query.limit ?? ADMIN_ELIGIBILITY_PAGE_DEFAULT
    const eligibility = eligibilityRepo()
    const [rows, counts] = await Promise.all([
      eligibility.listEligibilityPage({
        ...(query.verdict !== undefined ? { verdict: query.verdict } : {}),
        ...(query.state !== undefined ? { state: query.state } : {}),
        limit: limit + 1,
        checksLimit: MAX_ELIGIBILITY_CHECKS_SHOWN,
        afterOrganizationId: query.cursor ?? null,
      }),
      eligibility.verdictCounts(),
    ])
    const page = rows.slice(0, limit)
    const last = page[page.length - 1]

    const payload: AdminPaymentsEligibilityListResponse = {
      items: page.map((row) => ({
        organizationId: row.organizationId,
        orgName: row.orgName,
        orgSlug: row.orgSlug,
        paymentsState: row.paymentsState,
        donationsEnabled: row.donationsEnabled,
        donationsDisabledReason: row.donationsEnabled
          ? null
          : (row.donationsDisabledReasonText ?? row.donationsDisabledReason ?? null),
        eligibility: {
          verdict: row.verdict,
          reasons: row.reasons,
          einLast4: einLast4(row.ein),
          irsLegalName: row.irsLegalName,
          deductibilityCode: row.deductibilityCode,
          foundationCode: row.foundationCode,
          graceExpiresAt: row.graceExpiresAt?.toISOString() ?? null,
          evaluatedAt: row.evaluatedAt?.toISOString() ?? null,
          nextCheckAt: row.nextCheckAt?.toISOString() ?? null,
          checks: row.checks.map((check) => ({
            source: check.source,
            sourceRevisionDate: check.sourceRevisionDate,
            matched: check.matched,
            verdictContribution: check.verdictContribution,
            detail: check.detail,
            checkedAt: check.checkedAt.toISOString(),
          })),
        },
        einSource: row.einSource,
        groupExemptionSubordinate: row.groupExemptionSubordinate,
        centralOrgConfirmedAt: row.centralOrgConfirmedAt?.toISOString() ?? null,
      })),
      nextCursor: rows.length > limit && last !== undefined ? last.organizationId : null,
      counts: {
        eligible: counts.eligible,
        grace: counts.grace,
        ineligible: counts.ineligible,
        reviewRequired: counts.review_required,
        unknown: counts.unknown,
      },
    }
    reply.status(200).send(payload)
  })

  route(app, "adminSetOrgEligibilityEin", { preHandler: csrfProtect }, async (request, reply) => {
    const actorId = requireAuth(request)
    const { id, body } = parseBodyWithId(SetOrgEligibilityEinRequestSchema, request)
    if ((await orgRepo().findOrgById(id)) === null) throw AppError.notFound("Organization not found")

    const result = await eligibilityService().setEin({
      organizationId: id,
      ein: body.ein,
      source: "operator",
      actorUserId: actorId,
    })
    await writeAudit(container.getDb().sql, {
      actorId,
      action: "org_payments.ein_set",
      target: `organization:${id}`,
      meta: { einLast4: einLast4(result.ein), changed: result.changed, evaluationQueued: result.queued },
    })

    const payload: SetOrgEligibilityEinResponse = { ok: true, einLast4: einLast4(result.ein) ?? "" }
    reply.status(200).send(payload)
  })

  route(app, "adminConfirmOrgCentralOrg", { preHandler: csrfProtect }, async (request, reply) => {
    const actorId = requireAuth(request)
    const { id, body } = parseBodyWithId(ConfirmOrgCentralOrgRequestSchema, request)
    if ((await orgRepo().findOrgById(id)) === null) throw AppError.notFound("Organization not found")

    const result = await eligibilityService().setCentralOrgConfirmation({
      organizationId: id,
      confirmed: body.confirmed,
      actorUserId: actorId,
      note: body.note ?? null,
    })
    await writeAudit(container.getDb().sql, {
      actorId,
      action: body.confirmed
        ? "org_payments.central_org_confirmed"
        : "org_payments.central_org_confirmation_withdrawn",
      target: `organization:${id}`,
      meta: { note: body.note ?? null, evaluationQueued: result.queued },
    })

    const payload: ConfirmOrgCentralOrgResponse = {
      ok: true,
      centralOrgConfirmedAt: result.centralOrgConfirmedAt?.toISOString() ?? null,
    }
    reply.status(200).send(payload)
  })

  route(app, "adminEvaluateOrgEligibility", { preHandler: csrfProtect }, async (request, reply) => {
    const actorId = requireAuth(request)
    const { id } = idParam(request)
    if ((await orgRepo().findOrgById(id)) === null) throw AppError.notFound("Organization not found")

    const queued = await eligibilityService().requestEvaluation(id)
    await writeAudit(container.getDb().sql, {
      actorId,
      action: "org_payments.eligibility_evaluation_requested",
      target: `organization:${id}`,
      meta: { queued },
    })

    const payload: EvaluateOrgEligibilityResponse = { ok: true, queued }
    reply.status(200).send(payload)
  })

  route(
    app,
    "adminSetOrgDonationsEnabled",
    { preHandler: csrfProtect },
    async (request, reply) => {
      const actorId = requireAuth(request)
      const { id, body } = parseBodyWithId(SetOrgDonationsEnabledRequestSchema, request)

      const donationsEnabled = await service().setDonationsEnabledByOperator({
        organizationId: id,
        enabled: body.enabled,
        reasonText: body.reason,
        actorUserId: actorId,
      })

      await writeAudit(container.getDb().sql, {
        actorId,
        action: body.enabled ? "org_payments.donations_enabled" : "org_payments.donations_disabled",
        target: `organization:${id}`,
        meta: { reason: body.reason },
      })

      const payload: SetOrgDonationsEnabledResponse = { ok: true, donationsEnabled }
      reply.status(200).send(payload)
    },
  )

  route(app, "adminListDonations", async (request, reply) => {
    const query = parse(AdminDonationListQuerySchema, request.query ?? {})
    const limit = query.limit ?? ADMIN_DONATIONS_PAGE_DEFAULT
    const repo = donationRepo()
    const rows = await repo.listForAdmin({
      livemode: filingLivemode(),
      ...(query.organizationId !== undefined ? { organizationId: query.organizationId } : {}),
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.from !== undefined ? { from: new Date(query.from) } : {}),
      ...(query.to !== undefined ? { to: new Date(query.to) } : {}),
      ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
      limit: limit + 1,
    })
    const page = rows.slice(0, limit)
    const last = page[page.length - 1]

    const payload: AdminDonationListResponse = {
      items: page.map((row) => ({
        id: row.id,
        reference: row.reference,
        organizationId: row.organizationId,
        orgName: row.orgName,
        amount: { amountMinor: row.amountMinor, currency: "USD" as const },
        platformFeeMinor: row.feePlatformMinor - row.feeRefundedMinor,
        status: row.status,
        disputeState: row.disputeState,
        refundedTotalMinor: row.refundedTotalMinor,
        chargedAt: row.chargedAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
        receiptSentAt: row.receiptSentAt?.toISOString() ?? null,
        livemode: row.livemode,
      })),
      nextCursor:
        rows.length > limit && last !== undefined
          ? encodeDonationCursor(last.createdAt, last.id)
          : null,
      totals: await repo.adminTotals({
        livemode: filingLivemode(),
        ...(query.organizationId !== undefined ? { organizationId: query.organizationId } : {}),
        ...(query.status !== undefined ? { status: query.status } : {}),
        ...(query.from !== undefined ? { from: new Date(query.from) } : {}),
        ...(query.to !== undefined ? { to: new Date(query.to) } : {}),
        limit,
      }),
    }
    reply.status(200).send(payload)
  })

  route(app, "adminDonationTotalsByOrg", async (request, reply) => {
    const query = parse(AdminDonationTotalsByOrgQuerySchema, request.query ?? {})
    const from = new Date(query.from)
    const to = new Date(query.to)
    if (to.getTime() < from.getTime()) {
      throw AppError.validation({ to: "before_from" }, "`to` must not be earlier than `from`.")
    }
    const cap = Math.min(query.limit ?? ADMIN_DONATION_TOTALS_ORG_CAP, ADMIN_DONATION_TOTALS_ORG_CAP)
    const rows = await donationRepo().adminTotalsByOrg({
      from,
      to,
      livemode: filingLivemode(),
      ...(query.status !== undefined ? { status: query.status } : {}),
      limit: cap + 1,
    })
    const page = rows.slice(0, cap)
    const payload: AdminDonationTotalsByOrgResponse = {
      from: from.toISOString(),
      to: to.toISOString(),
      items: page.map((row) => ({
        organizationId: row.organizationId,
        orgName: row.orgName,
        orgSlug: row.orgSlug,
        count: row.count,
        grossMinor: row.grossMinor,
        platformFeeMinor: row.platformFeeMinor,
        refundedMinor: row.refundedMinor,
        netMinor: row.grossMinor - row.platformFeeMinor - row.refundedMinor,
        firstChargedAt: row.firstChargedAt?.toISOString() ?? null,
        lastChargedAt: row.lastChargedAt?.toISOString() ?? null,
      })),
      truncated: rows.length > cap,
      totals: page.reduce(
        (sum, row) => ({
          count: sum.count + row.count,
          grossMinor: sum.grossMinor + row.grossMinor,
          platformFeeMinor: sum.platformFeeMinor + row.platformFeeMinor,
          refundedMinor: sum.refundedMinor + row.refundedMinor,
          netMinor: sum.netMinor + row.grossMinor - row.platformFeeMinor - row.refundedMinor,
        }),
        { count: 0, grossMinor: 0, platformFeeMinor: 0, refundedMinor: 0, netMinor: 0 },
      ),
    }
    reply.status(200).send(payload)
  })

  route(app, "adminGetPlatformDonationSettings", async (_request, reply) => {
    const env = container.env
    const payload: GetAdminPlatformDonationSettingsResponse = {
      paymentsEnabled: env.PAYMENTS_ENABLED,
      registrationNumber: env.CA_CFP_REGISTRATION_NUMBER ?? null,
      platformFeeBps: env.DONATION_PLATFORM_FEE_BPS,
      minAmountMinor: env.DONATION_MIN_MINOR,
      maxAmountMinor: env.DONATION_MAX_MINOR,
      currency: DONATION_CURRENCY,
      eligibilityStaleGraceHours: env.ELIGIBILITY_STALE_GRACE_HOURS,
      paymentMethodDomains: [...env.PAYMENT_METHOD_DOMAINS],
      reviewRequiredBlocks: REVIEW_REQUIRED_BLOCKS_DONATIONS,
    }
    reply.status(200).send(payload)
  })
}
