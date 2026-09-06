import type Stripe from "stripe"
import { WebhookSignatureError } from "@civfix/shared/interfaces"
import type {
  AccountLink,
  ApplicationFeeRecord,
  ApplicationFeeRefund,
  BalanceTransactionRecord,
  CheckoutSessionSnapshot,
  ConnectedAccountStatus,
  CreateAccountLinkInput,
  CreateConnectedAccountInput,
  CreateDonationCheckoutInput,
  DonationCheckoutSession,
  DonationPaymentStatus,
  DonationSessionStatus,
  PaymentMethodDomainRegistration,
  PaymentRefundRecord,
  PaymentSnapshot,
  Payments,
  PaymentsListInput,
  PaymentsMode,
  PaymentsPage,
  PaymentsWebhookEvent,
  PaymentsWebhookScope,
} from "@civfix/shared/interfaces"
import { paymentFailure } from "../errors/payment-failure.js"

export const STRIPE_DEFAULT_API_VERSION = "2026-08-26.dahlia"

export const STRIPE_TIMEOUT_MS = 20_000

export const STRIPE_MAX_NETWORK_RETRIES = 2

export const STRIPE_APP_INFO = { name: "civfix", url: "https://civfix.org" } as const

export const STRIPE_LIST_PAGE_LIMIT = 100

export const APPLICATION_FEE_DETAIL_TYPE = "application_fee"

const LIVE_KEY_PREFIXES = ["rk_live_", "sk_live_"] as const

export function modeOfSecretKey(secretKey: string): PaymentsMode {
  return LIVE_KEY_PREFIXES.some((prefix) => secretKey.startsWith(prefix)) ? "live" : "test"
}

export type StripeClientFactory = () => Promise<Stripe>

export interface StripePaymentsConfig {
  secretKey: string
  apiVersion?: string
  webhookSecrets: { connect: readonly string[]; platform: readonly string[] }
  clientFactory?: StripeClientFactory
}

interface StripeAccountLike {
  id: string
  charges_enabled?: boolean | undefined
  payouts_enabled?: boolean | undefined
  details_submitted?: boolean | undefined
  capabilities?: Record<string, unknown> | undefined
  requirements?:
    | {
        disabled_reason?: string | null | undefined
        currently_due?: string[] | null | undefined
        past_due?: string[] | null | undefined
        pending_verification?: string[] | null | undefined
        current_deadline?: number | null | undefined
      }
    | null
    | undefined
  future_requirements?: { currently_due?: string[] | null | undefined } | null | undefined
}

function stringList(value: string[] | null | undefined): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []
}

function capabilityMap(value: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (value === undefined || value === null) return out
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "string") out[key] = raw
  }
  return out
}

export function toConnectedAccountStatus(
  account: StripeAccountLike,
  livemode: boolean,
): ConnectedAccountStatus {
  const requirements = account.requirements ?? {}
  const deadline = requirements.current_deadline
  return {
    accountId: account.id,
    livemode,
    detailsSubmitted: account.details_submitted === true,
    chargesEnabled: account.charges_enabled === true,
    payoutsEnabled: account.payouts_enabled === true,
    disabledReason: typeof requirements.disabled_reason === "string" ? requirements.disabled_reason : null,
    currentlyDue: stringList(requirements.currently_due),
    pastDue: stringList(requirements.past_due),
    pendingVerification: stringList(requirements.pending_verification),
    futureCurrentlyDue: stringList(account.future_requirements?.currently_due),
    currentDeadlineSec: typeof deadline === "number" ? deadline : null,
    capabilities: capabilityMap(account.capabilities),
  }
}

function sessionStatus(value: string | null | undefined): DonationSessionStatus {
  return value === "complete" || value === "expired" ? value : "open"
}

function paymentStatus(value: string | null | undefined): DonationPaymentStatus {
  return value === "paid" || value === "no_payment_required" ? value : "unpaid"
}

export interface BalanceTransactionFeeSplit {
  stripeFeeMinor: number
  applicationFeeMinor: number
  netMinor: number
}

export interface BalanceTransactionLike {
  amount: number
  fee: number
  net: number
  fee_details?: readonly { amount?: number | null; type?: string | null }[] | null | undefined
}

export function splitBalanceTransactionFees(
  balanceTransaction: BalanceTransactionLike,
  applicationFeeFallbackMinor: number | null,
): BalanceTransactionFeeSplit {
  const details = Array.isArray(balanceTransaction.fee_details)
    ? balanceTransaction.fee_details
    : []
  const detailed = details.reduce(
    (sum, detail) =>
      detail?.type === APPLICATION_FEE_DETAIL_TYPE && typeof detail.amount === "number"
        ? sum + detail.amount
        : sum,
    0,
  )
  const observed =
    details.length > 0 ? detailed : Math.max(0, applicationFeeFallbackMinor ?? 0)
  const applicationFeeMinor = Math.min(Math.max(0, observed), balanceTransaction.fee)
  const stripeFeeMinor = balanceTransaction.fee - applicationFeeMinor
  return {
    stripeFeeMinor,
    applicationFeeMinor,
    netMinor: balanceTransaction.amount - stripeFeeMinor - applicationFeeMinor,
  }
}

const ALREADY_REFUNDED_SIGNALS = [
  "already been refunded",
  "already refunded",
  "exceeds the remaining",
  "greater than unrefunded amount",
  "cannot refund more",
  "no remaining amount",
] as const

export function isAlreadyRefundedError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false
  const candidate = err as { type?: unknown; rawType?: unknown; code?: unknown; message?: unknown }
  const kinds = [candidate.type, candidate.rawType]
  if (!kinds.includes("StripeInvalidRequestError") && !kinds.includes("invalid_request_error")) {
    return false
  }
  const code = typeof candidate.code === "string" ? candidate.code : ""
  if (code === "charge_already_refunded" || code === "fee_already_refunded") return true
  const message = typeof candidate.message === "string" ? candidate.message.toLowerCase() : ""
  return ALREADY_REFUNDED_SIGNALS.some((signal) => message.includes(signal))
}

function idOf(value: unknown): string | null {
  if (typeof value === "string") return value
  if (typeof value === "object" && value !== null) {
    const id = (value as { id?: unknown }).id
    if (typeof id === "string") return id
  }
  return null
}

export class StripePayments implements Payments {
  private readonly config: StripePaymentsConfig
  private readonly clientFactory: StripeClientFactory
  private client: Stripe | undefined

  constructor(config: StripePaymentsConfig) {
    this.config = config
    this.clientFactory = config.clientFactory ?? (() => this.createDefaultClient())
  }

  private async createDefaultClient(): Promise<Stripe> {
    const { default: StripeCtor } = await import("stripe")
    return new StripeCtor(this.config.secretKey, {
      apiVersion: (this.config.apiVersion ??
        STRIPE_DEFAULT_API_VERSION) as Stripe.StripeConfig["apiVersion"],
      maxNetworkRetries: STRIPE_MAX_NETWORK_RETRIES,
      timeout: STRIPE_TIMEOUT_MS,
      telemetry: false,
      appInfo: { ...STRIPE_APP_INFO },
    })
  }

  private async stripe(): Promise<Stripe> {
    if (this.client === undefined) this.client = await this.clientFactory()
    return this.client
  }

  mode(): PaymentsMode {
    return modeOfSecretKey(this.config.secretKey)
  }

  private livemode(): boolean {
    return this.mode() === "live"
  }

  async createConnectedAccount(input: CreateConnectedAccountInput): Promise<ConnectedAccountStatus> {
    const stripe = await this.stripe()
    try {
      const account = await stripe.accounts.create(
        {
          type: "standard",
          country: "US",
          ...(input.email !== undefined ? { email: input.email } : {}),
          business_type: "non_profit",
          business_profile: {
            name: input.legalName,
            ...(input.url !== undefined ? { url: input.url } : {}),
          },
          ...(input.statementDescriptorHint !== undefined
            ? { settings: { payments: { statement_descriptor: input.statementDescriptorHint } } }
            : {}),
          metadata: { civfix_org_id: input.orgId },
        },
        { idempotencyKey: input.idempotencyKey },
      )
      return toConnectedAccountStatus(account as StripeAccountLike, this.livemode())
    } catch (err) {
      throw paymentFailure(err)
    }
  }

  async createAccountLink(input: CreateAccountLinkInput): Promise<AccountLink> {
    const stripe = await this.stripe()
    try {
      const link = await stripe.accountLinks.create({
        account: input.accountId,
        type: input.type === "update" ? "account_update" : "account_onboarding",
        refresh_url: input.refreshUrl,
        return_url: input.returnUrl,
        collect: "eventually_due",
      })
      return { url: link.url, expiresAtSec: link.expires_at }
    } catch (err) {
      throw paymentFailure(err)
    }
  }

  async retrieveAccount(accountId: string): Promise<ConnectedAccountStatus> {
    const stripe = await this.stripe()
    try {
      const account = await stripe.accounts.retrieve(accountId)
      return toConnectedAccountStatus(account as StripeAccountLike, this.livemode())
    } catch (err) {
      throw paymentFailure(err)
    }
  }

  async registerPaymentMethodDomain(
    accountId: string,
    domain: string,
  ): Promise<PaymentMethodDomainRegistration> {
    const stripe = await this.stripe()
    try {
      const registration = await stripe.paymentMethodDomains.create(
        { domain_name: domain, enabled: true },
        { stripeAccount: accountId },
      )
      return {
        id: registration.id,
        domain: registration.domain_name,
        enabled: registration.enabled === true,
      }
    } catch (err) {
      throw paymentFailure(err)
    }
  }

  async createDonationCheckout(
    input: CreateDonationCheckoutInput,
  ): Promise<DonationCheckoutSession> {
    const stripe = await this.stripe()
    const metadata = {
      civfix_donation_id: input.donationId,
      civfix_org_id: input.orgId,
    }
    try {
      const session = await stripe.checkout.sessions.create(
        {
          ui_mode: "elements",
          mode: "payment",
          payment_method_types: ["card"],
          expires_at: input.expiresAtSec,
          ...(input.customerEmail !== undefined ? { customer_email: input.customerEmail } : {}),
          line_items: [
            {
              quantity: 1,
              price_data: {
                currency: input.currency,
                unit_amount: input.amountMinor,
                product_data: { name: input.productName },
              },
            },
          ],
          payment_intent_data: {
            description: input.productName,
            metadata,
            ...(input.applicationFeeMinor > 0
              ? { application_fee_amount: input.applicationFeeMinor }
              : {}),
          },
          metadata,
        },
        { stripeAccount: input.accountId, idempotencyKey: input.idempotencyKey },
      )
      const paymentIntentId = idOf(session.payment_intent)
      const clientSecret = session.client_secret
      if (paymentIntentId === null || clientSecret === null || clientSecret === undefined) {
        throw paymentFailure({
          type: "StripeAPIError",
          code: "checkout_session_incomplete",
          statusCode: 502,
        })
      }
      return {
        sessionId: session.id,
        paymentIntentId,
        clientSecret,
        expiresAtSec: session.expires_at,
      }
    } catch (err) {
      throw paymentFailure(err)
    }
  }

  async retrieveCheckoutSession(
    accountId: string,
    sessionId: string,
  ): Promise<CheckoutSessionSnapshot> {
    const stripe = await this.stripe()
    try {
      const session = await stripe.checkout.sessions.retrieve(sessionId, undefined, {
        stripeAccount: accountId,
      })
      const status = sessionStatus(session.status)
      const clientSecret = typeof session.client_secret === "string" ? session.client_secret : null
      return {
        sessionId: session.id,
        paymentIntentId: idOf(session.payment_intent),
        clientSecret: status === "open" ? clientSecret : null,
        status,
        expiresAtSec: typeof session.expires_at === "number" ? session.expires_at : null,
      }
    } catch (err) {
      throw paymentFailure(err)
    }
  }

  async retrieveDonation(accountId: string, sessionId: string): Promise<PaymentSnapshot> {
    const stripe = await this.stripe()
    try {
      const session = await stripe.checkout.sessions.retrieve(
        sessionId,
        { expand: ["payment_intent.latest_charge.balance_transaction"] },
        { stripeAccount: accountId },
      )
      const intent = typeof session.payment_intent === "object" ? session.payment_intent : null
      const charge =
        intent !== null && typeof intent.latest_charge === "object" ? intent.latest_charge : null
      const balanceTransaction =
        charge !== null && typeof charge.balance_transaction === "object"
          ? charge.balance_transaction
          : null
      const card = charge?.payment_method_details?.card ?? null
      const split =
        balanceTransaction === null
          ? null
          : splitBalanceTransactionFees(
              balanceTransaction,
              typeof charge?.application_fee_amount === "number"
                ? charge.application_fee_amount
                : null,
            )

      return {
        status: sessionStatus(session.status),
        paymentStatus: paymentStatus(session.payment_status),
        amountMinor: session.amount_total ?? 0,
        stripeFeeMinor: split === null ? null : split.stripeFeeMinor,
        applicationFeeMinor: split === null ? null : split.applicationFeeMinor,
        netMinor: split === null ? null : split.netMinor,
        cardBrand: typeof card?.brand === "string" ? card.brand : null,
        cardLast4: typeof card?.last4 === "string" ? card.last4 : null,
        chargedAtSec: charge === null ? null : charge.created,
        livemode: this.livemode(),
        chargeId: charge === null ? idOf(intent?.latest_charge) : charge.id,
        applicationFeeId: charge === null ? null : idOf(charge.application_fee),
      }
    } catch (err) {
      throw paymentFailure(err)
    }
  }

  async listRefunds(accountId: string, chargeId: string): Promise<PaymentRefundRecord[]> {
    const stripe = await this.stripe()
    try {
      const out: PaymentRefundRecord[] = []
      for await (const refund of stripe.refunds.list(
        { charge: chargeId, limit: STRIPE_LIST_PAGE_LIMIT },
        { stripeAccount: accountId },
      )) {
        out.push({
          id: refund.id,
          amountMinor: refund.amount,
          status: typeof refund.status === "string" ? refund.status : "pending",
          reason: typeof refund.reason === "string" ? refund.reason : null,
          createdSec: refund.created,
        })
      }
      return out
    } catch (err) {
      throw paymentFailure(err)
    }
  }

  async listBalanceTransactions(
    accountId: string,
    input: PaymentsListInput,
  ): Promise<PaymentsPage<BalanceTransactionRecord>> {
    const stripe = await this.stripe()
    try {
      const page = await stripe.balanceTransactions.list(
        {
          limit: input.limit ?? STRIPE_LIST_PAGE_LIMIT,
          type: "charge",
          ...(input.since !== undefined && input.since !== null
            ? { created: { gt: input.since } }
            : {}),
          ...(input.cursor !== undefined && input.cursor !== null
            ? { starting_after: input.cursor }
            : {}),
        },
        { stripeAccount: accountId },
      )
      const items = page.data.map((transaction) => {
        const split = splitBalanceTransactionFees(transaction, null)
        return {
          id: transaction.id,
          type: transaction.type,
          amountMinor: transaction.amount,
          feeMinor: transaction.fee,
          stripeFeeMinor: split.stripeFeeMinor,
          applicationFeeMinor: split.applicationFeeMinor,
          netMinor: transaction.net,
          currency: transaction.currency,
          createdSec: transaction.created,
          sourceId: idOf(transaction.source),
        }
      })
      const last = items[items.length - 1]
      return { items, nextCursor: page.has_more && last !== undefined ? last.id : null }
    } catch (err) {
      throw paymentFailure(err)
    }
  }

  async listApplicationFees(input: PaymentsListInput): Promise<PaymentsPage<ApplicationFeeRecord>> {
    const stripe = await this.stripe()
    try {
      const page = await stripe.applicationFees.list({
        limit: input.limit ?? STRIPE_LIST_PAGE_LIMIT,
        ...(input.since !== undefined && input.since !== null
          ? { created: { gt: input.since } }
          : {}),
        ...(input.cursor !== undefined && input.cursor !== null
          ? { starting_after: input.cursor }
          : {}),
      })
      const items = page.data.map((fee) => ({
        id: fee.id,
        chargeId: idOf(fee.charge),
        amountMinor: fee.amount,
        amountRefundedMinor: fee.amount_refunded,
        currency: fee.currency,
        createdSec: fee.created,
        livemode: fee.livemode === true,
      }))
      const last = items[items.length - 1]
      return { items, nextCursor: page.has_more && last !== undefined ? last.id : null }
    } catch (err) {
      throw paymentFailure(err)
    }
  }

  async refundApplicationFee(
    applicationFeeId: string,
    amountMinor: number,
    idempotencyKey: string,
  ): Promise<ApplicationFeeRefund> {
    const stripe = await this.stripe()
    try {
      const refund = await stripe.applicationFees.createRefund(
        applicationFeeId,
        { amount: amountMinor },
        { idempotencyKey },
      )
      return { id: refund.id, amountMinor: refund.amount, status: "succeeded" }
    } catch (err) {
      if (isAlreadyRefundedError(err)) {
        return { id: applicationFeeId, amountMinor: 0, status: "skipped" }
      }
      throw paymentFailure(err)
    }
  }

  verifyWebhookSignature(
    rawBody: string | Uint8Array,
    signatureHeader: string,
    scope: PaymentsWebhookScope,
  ): PaymentsWebhookEvent {
    const client = this.client
    if (client === undefined) {
      throw new WebhookSignatureError(scope, "stripe client not initialized")
    }
    const secrets = this.config.webhookSecrets[scope]
    if (secrets.length === 0) {
      throw new WebhookSignatureError(scope, `no webhook secret configured for scope ${scope}`)
    }
    const payload = typeof rawBody === "string" ? rawBody : Buffer.from(rawBody)
    let lastError: unknown
    for (const secret of secrets) {
      try {
        const event = client.webhooks.constructEvent(payload, signatureHeader, secret)
        return toWebhookEvent(event, scope)
      } catch (err) {
        lastError = err
      }
    }
    throw new WebhookSignatureError(
      scope,
      lastError instanceof Error ? lastError.message : "signature verification failed",
    )
  }

  async warmup(): Promise<void> {
    await this.stripe()
  }
}

export function toWebhookEvent(
  event: Stripe.Event,
  scope: PaymentsWebhookScope,
): PaymentsWebhookEvent {
  const account = (event as { account?: unknown }).account
  return {
    id: event.id,
    type: event.type,
    scope,
    accountId: typeof account === "string" ? account : null,
    livemode: event.livemode === true,
    apiVersion: typeof event.api_version === "string" ? event.api_version : null,
    createdSec: event.created,
    data: { object: event.data.object as unknown as Record<string, unknown> },
  }
}
