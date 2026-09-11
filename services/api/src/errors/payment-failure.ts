import { AppError, ErrorCode } from "@civfix/shared"

export const PAYMENT_FAILURE_FIELD = "paymentProvider"

export const PAN_RE = /\b(?:\d[ -]*?){13,19}\b/g

export const PAN_REDACTION = "[redacted-pan]"

export function isLuhnValid(candidate: string): boolean {
  const digits = candidate.replace(/\D/g, "")
  if (digits.length < 13 || digits.length > 19) return false
  let sum = 0
  let doubled = false
  for (let position = digits.length - 1; position >= 0; position -= 1) {
    let value = digits.charCodeAt(position) - 48
    if (doubled) {
      value *= 2
      if (value > 9) value -= 9
    }
    sum += value
    doubled = !doubled
  }
  return sum % 10 === 0
}

export function redactPans(text: string, replacement: string): string {
  return text.replace(PAN_RE, (match) => (isLuhnValid(match) ? replacement : match))
}

export function scrubPan(text: string): string {
  return redactPans(text, PAN_REDACTION)
}

export const PAYMENT_FAILURE_KINDS = [
  "unavailable",
  "rate_limited",
  "conflict",
  "unauthorized",
  "internal",
] as const

export type PaymentFailureKind = (typeof PAYMENT_FAILURE_KINDS)[number]

export interface PaymentErrorSnapshot {
  type: string | null
  code: string | null
  statusCode: number | null
  requestId: string | null
}

const INDETERMINATE_TYPES: ReadonlySet<string> = new Set([
  "StripeConnectionError",
  "StripeAPIError",
  "StripeUnknownError",
])

const UNAVAILABLE_INVALID_REQUEST_CODES: ReadonlySet<string> = new Set([
  "account_invalid",
  "charges_disabled",
  "account_country_invalid_address",
  "payouts_disabled",
])

const MAX_FIELD_LEN = 120

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key]
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  return trimmed.length > MAX_FIELD_LEN ? trimmed.slice(0, MAX_FIELD_LEN) : trimmed
}

export function paymentErrorSnapshot(err: unknown): PaymentErrorSnapshot {
  if (typeof err !== "object" || err === null) {
    return { type: null, code: null, statusCode: null, requestId: null }
  }
  const source = err as Record<string, unknown>
  const statusCode = source.statusCode
  return {
    type: readString(source, "type") ?? readString(source, "name"),
    code: readString(source, "code"),
    statusCode: typeof statusCode === "number" && Number.isFinite(statusCode) ? statusCode : null,
    requestId: readString(source, "requestId"),
  }
}

export function classifyPaymentFailure(err: unknown): PaymentFailureKind {
  const snapshot = paymentErrorSnapshot(err)
  const type = snapshot.type ?? ""

  if (type === "StripeSignatureVerificationError" || type === "WebhookSignatureError") {
    return "unauthorized"
  }
  if (type === "StripeRateLimitError" || snapshot.statusCode === 429) return "rate_limited"
  if (type === "StripeIdempotencyError") return "conflict"
  if (type === "StripeAuthenticationError" || type === "StripePermissionError") return "internal"
  if (INDETERMINATE_TYPES.has(type)) return "unavailable"
  if (snapshot.statusCode !== null && snapshot.statusCode >= 500) return "unavailable"
  if (type === "StripeInvalidRequestError") {
    return snapshot.code !== null && UNAVAILABLE_INVALID_REQUEST_CODES.has(snapshot.code)
      ? "unavailable"
      : "internal"
  }
  return "internal"
}

export function paymentFailure(err: unknown): AppError {
  const kind = classifyPaymentFailure(err)
  const snapshot = paymentErrorSnapshot(err)
  const fields = { [PAYMENT_FAILURE_FIELD]: kind }

  switch (kind) {
    case "unavailable":
      return new AppError(
        ErrorCode.PAYMENT_UNAVAILABLE,
        "Payments are temporarily unavailable. Nothing was charged that we can confirm; please try again shortly.",
        { fields, cause: snapshot },
      )
    case "rate_limited":
      return AppError.rateLimited("Too many payment requests; please retry shortly.")
    case "conflict":
      return AppError.conflict("This payment request is already in flight; retry with a new request.")
    case "unauthorized":
      return AppError.unauthorized("Invalid payment webhook signature.")
    default:
      return AppError.internal("Payment provider request failed.")
  }
}

export function isIndeterminatePaymentFailure(err: unknown): boolean {
  return classifyPaymentFailure(err) === "unavailable"
}

export function paymentFailureKind(err: unknown): PaymentFailureKind | null {
  if (typeof err !== "object" || err === null) return null
  const fields = (err as { fields?: unknown }).fields
  if (typeof fields !== "object" || fields === null) return null
  const value = (fields as Record<string, unknown>)[PAYMENT_FAILURE_FIELD]
  if (typeof value !== "string") return null
  return (PAYMENT_FAILURE_KINDS as readonly string[]).includes(value)
    ? (value as PaymentFailureKind)
    : null
}

export const PAYOUT_FAILURE_CODES = [
  "payouts_not_allowed",
  "balance_insufficient",
  "account_invalid",
] as const

export type PayoutFailureCode = (typeof PAYOUT_FAILURE_CODES)[number]

const PAYOUT_FAILURE_COPY: Readonly<Record<PayoutFailureCode, string>> = {
  payouts_not_allowed:
    "Stripe has not enabled payouts on this account yet. Finish the payout details in Stripe, then try again.",
  balance_insufficient:
    "The available balance is lower than the amount requested. Try again once more donations have settled.",
  account_invalid:
    "This organization's payout account can't be reached right now. Reconnect it in Stripe and try again.",
}

export function payoutFailureCode(err: unknown): PayoutFailureCode | null {
  if (typeof err !== "object" || err === null) return null
  const source = err as Record<string, unknown>
  const code = source.code
  if (typeof code === "string") {
    const direct = PAYOUT_FAILURE_CODES.find((known) => known === code)
    if (direct !== undefined) return direct
  }
  const message = source.message
  if (typeof message !== "string") return null
  return PAYOUT_FAILURE_CODES.find((known) => message.includes(known)) ?? null
}

export function payoutRefusal(code: PayoutFailureCode): AppError {
  const message = PAYOUT_FAILURE_COPY[code]
  if (code === "balance_insufficient") return AppError.conflict(message)
  if (code === "account_invalid") return AppError.paymentUnavailable(message)
  return new AppError(ErrorCode.VALIDATION, message, {
    fields: { [PAYMENT_FAILURE_FIELD]: code },
  })
}

export function payoutFailure(err: unknown): AppError {
  if (err instanceof AppError) return err
  const code = payoutFailureCode(err)
  return code === null ? paymentFailure(err) : payoutRefusal(code)
}
