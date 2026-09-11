import { AppError, type OrgBalanceDTO, type PayoutDTO } from "@civfix/shared"
import type { Payments } from "@civfix/shared/interfaces"
import type { CounterStore } from "../../abuse/counter-store.js"
import { payoutFailure, payoutRefusal, payoutRefusalCode } from "../../errors/payment-failure.js"
import type { OrgPaymentsRepository, OrgPaymentsView } from "./org-payments-repository.drizzle.js"
import { encodePayoutCursor } from "./org-payouts-repository.drizzle.js"
import type { OrgPayoutRecord, OrgPayoutsRepository } from "./org-payouts-repository.types.js"

export const ORG_PAYOUTS_PER_HOUR = 5

export const ORG_PAYOUT_WINDOW_SEC = 60 * 60

export const PAYOUT_CURRENCY = "usd"

export const NO_PAYOUT_ACCOUNT_MESSAGE =
  "Connect a payout account before moving money to a bank account."

export const NOTHING_AVAILABLE_MESSAGE =
  "There is nothing available to pay out yet. Donations become available once Stripe settles them."

export const PAYOUT_RATE_LIMIT_MESSAGE =
  "This organization has requested too many payouts recently. Please try again later."

export const PAYOUT_IN_FLIGHT_MESSAGE =
  "That payout is still being submitted. Refresh the payout list in a moment."

export const RECONCILE_PAGE_LIMIT = 25

export const RECONCILE_SLACK_SEC = 300

export const PAYOUT_NEVER_SUBMITTED_MESSAGE =
  "This payout never reached Stripe, so no money moved. Send it again when you are ready."

export const PAYOUT_UNCONFIRMED_MESSAGE =
  "An earlier payout has not been confirmed by Stripe yet. Refresh the payout list in a moment before sending another."

export interface CreateOrgPayoutInput {
  amountMinor?: number
  currency: "USD"
  idempotencyKey: string
}

export interface OrgPayoutsServiceDeps {
  orgs: OrgPaymentsRepository
  payouts: OrgPayoutsRepository
  payments: Payments
  counters: CounterStore
  env: { PAYMENTS_ENABLED: boolean }
  now?: () => Date
  logger?: { warn: (obj: unknown, msg?: string) => void; error: (obj: unknown, msg?: string) => void }
}

export interface OrgPayoutsService {
  getBalance(organizationId: string): Promise<OrgBalanceDTO>
  createPayout(
    organizationId: string,
    actorUserId: string,
    input: CreateOrgPayoutInput,
  ): Promise<PayoutDTO>
  listPayouts(input: {
    organizationId: string
    cursor?: string
    limit: number
  }): Promise<{ items: PayoutDTO[]; nextCursor: string | null }>
}

export function toPayoutDTO(record: OrgPayoutRecord): PayoutDTO {
  return {
    id: record.id,
    stripePayoutId: record.stripePayoutId ?? "",
    amount: { amountMinor: record.amountMinor, currency: "USD" },
    status: record.status,
    arrivalDate: record.arrivalDate?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
    failureMessage: record.failureMessage,
  }
}

export function makeOrgPayoutsService(deps: OrgPayoutsServiceDeps): OrgPayoutsService {
  const now = deps.now ?? (() => new Date())

  function requirePaymentsEnabled(): void {
    if (!deps.env.PAYMENTS_ENABLED) {
      throw AppError.paymentUnavailable("Payouts are not available.")
    }
  }

  async function loadView(organizationId: string): Promise<OrgPaymentsView> {
    const view = await deps.orgs.paymentsView(organizationId)
    if (view === null) throw AppError.notFound("Organization not found")
    return view
  }

  function connectedAccountId(view: OrgPaymentsView): string | null {
    const account = view.account
    if (account === null || account.deauthorizedAt !== null) return null
    return account.stripeAccountId
  }

  function emptyBalance(): OrgBalanceDTO {
    return {
      available: { amountMinor: 0, currency: "USD" },
      pending: { amountMinor: 0, currency: "USD" },
      payoutsEnabled: false,
      payoutSchedule: null,
      lastSyncedAt: now().toISOString(),
    }
  }

  async function settleUnconfirmed(row: OrgPayoutRecord): Promise<void> {
    let page
    try {
      page = await deps.payments.listPayouts(row.stripeAccountId, { limit: RECONCILE_PAGE_LIMIT })
    } catch (err) {
      deps.logger?.error(
        { organizationId: row.organizationId, payoutId: row.id, err: payoutFailure(err).code },
        "could not read the connected account to settle an unconfirmed org payout",
      )
      throw AppError.conflict(PAYOUT_UNCONFIRMED_MESSAGE)
    }
    const createdFrom = Math.floor(row.createdAt.getTime() / 1000) - RECONCILE_SLACK_SEC
    const candidates = page.items.filter(
      (payout) => payout.amountMinor === row.amountMinor && payout.createdSec >= createdFrom,
    )
    const known = await deps.payouts.knownStripePayoutIds(
      row.organizationId,
      candidates.map((payout) => payout.id),
    )
    const match = candidates
      .filter((payout) => !known.has(payout.id))
      .sort((a, b) => a.createdSec - b.createdSec)[0]

    if (match === undefined) {
      await deps.payouts.markFailed({
        id: row.id,
        failureMessage: PAYOUT_NEVER_SUBMITTED_MESSAGE,
        now: now(),
      })
      return
    }
    await deps.payouts.markSubmitted({
      id: row.id,
      organizationId: row.organizationId,
      stripePayoutId: match.id,
      status: match.status,
      arrivalDate: match.arrivalDateSec === null ? null : new Date(match.arrivalDateSec * 1000),
      failureMessage: null,
      now: now(),
    })
  }

  return {
    async getBalance(organizationId): Promise<OrgBalanceDTO> {
      const view = await loadView(organizationId)
      const accountId = connectedAccountId(view)
      if (!deps.env.PAYMENTS_ENABLED || accountId === null) return emptyBalance()

      const balance = await deps.payments.retrieveBalance(accountId)
      return {
        available: { amountMinor: balance.availableMinor, currency: "USD" },
        pending: { amountMinor: balance.pendingMinor, currency: "USD" },
        payoutsEnabled: balance.payoutsEnabled,
        payoutSchedule: balance.payoutSchedule,
        lastSyncedAt: now().toISOString(),
      }
    },

    async createPayout(organizationId, actorUserId, input): Promise<PayoutDTO> {
      requirePaymentsEnabled()
      const view = await loadView(organizationId)
      if (view.org.suspended) {
        throw AppError.forbidden(
          "This organization has been suspended, so it can't be changed right now.",
        )
      }
      const accountId = connectedAccountId(view)
      if (accountId === null) throw AppError.conflict(NO_PAYOUT_ACCOUNT_MESSAGE)

      const unconfirmed = await deps.payouts.findUnconfirmed(organizationId)
      if (unconfirmed !== null && unconfirmed.idempotencyKey !== input.idempotencyKey) {
        await settleUnconfirmed(unconfirmed)
      }

      const balance = await deps.payments.retrieveBalance(accountId)
      if (!balance.payoutsEnabled) throw payoutRefusal("payouts_not_allowed")

      const amountMinor = input.amountMinor ?? balance.availableMinor
      if (amountMinor <= 0) throw AppError.validation({ amountMinor: NOTHING_AVAILABLE_MESSAGE })
      if (amountMinor > balance.availableMinor) throw payoutRefusal("balance_insufficient")

      const pending = await deps.payouts.insertPending({
        organizationId,
        stripeAccountId: accountId,
        amountMinor,
        requestedBy: actorUserId,
        idempotencyKey: input.idempotencyKey,
        now: now(),
      })
      if (pending.replayed) {
        if (pending.record.status === "failed") {
          throw AppError.conflict(pending.record.failureMessage ?? PAYOUT_IN_FLIGHT_MESSAGE)
        }
        if (pending.record.stripePayoutId !== null) return toPayoutDTO(pending.record)
      } else {
        const requests = await deps.counters.incr(
          `org:payouts:${organizationId}`,
          ORG_PAYOUT_WINDOW_SEC,
        )
        if (requests > ORG_PAYOUTS_PER_HOUR) {
          throw AppError.rateLimited(PAYOUT_RATE_LIMIT_MESSAGE)
        }
      }

      let submitted
      try {
        submitted = await deps.payments.createPayout(accountId, {
          amountMinor: pending.record.amountMinor,
          currency: PAYOUT_CURRENCY,
          idempotencyKey: input.idempotencyKey,
        })
      } catch (err) {
        const failure = payoutFailure(err)
        if (payoutRefusalCode(failure) === null) {
          deps.logger?.error(
            { organizationId, payoutId: pending.record.id, code: failure.code },
            "org payout outcome unknown: the row stays pending until a payout webhook settles it",
          )
          throw failure
        }
        await deps.payouts.markFailed({
          id: pending.record.id,
          failureMessage: failure.message,
          now: now(),
        })
        deps.logger?.error(
          { organizationId, payoutId: pending.record.id, code: failure.code },
          "org payout refused by the payment provider: no money moved",
        )
        throw failure
      }

      const stored = await deps.payouts.markSubmitted({
        id: pending.record.id,
        organizationId,
        stripePayoutId: submitted.id,
        status: submitted.status,
        arrivalDate:
          submitted.arrivalDateSec === null ? null : new Date(submitted.arrivalDateSec * 1000),
        failureMessage: null,
        now: now(),
      })
      return toPayoutDTO(stored ?? { ...pending.record, stripePayoutId: submitted.id })
    },

    async listPayouts({ organizationId, cursor, limit }) {
      await loadView(organizationId)
      const rows = await deps.payouts.listForOrg({
        organizationId,
        ...(cursor !== undefined ? { cursor } : {}),
        limit: limit + 1,
      })
      const page = rows.slice(0, limit)
      const last = page[page.length - 1]
      return {
        items: page.map(toPayoutDTO),
        nextCursor:
          rows.length > limit && last !== undefined
            ? encodePayoutCursor(last.createdAt, last.id)
            : null,
      }
    },
  }
}
