import { AppError, ErrorCode } from "@civfix/shared"

export const SMS_FAILURE_FIELD = "smsDelivery"

export const SMS_FAILURE_KINDS = ["opted_out", "invalid_number", "permanent", "temporary"] as const

export type SmsFailureKind = (typeof SMS_FAILURE_KINDS)[number]

const ERROR_CODE_BY_KIND: Record<SmsFailureKind, ErrorCode> = {
  opted_out: ErrorCode.CONFLICT,
  invalid_number: ErrorCode.VALIDATION,
  permanent: ErrorCode.CONFLICT,
  temporary: ErrorCode.INTERNAL,
}

export function smsFailure(kind: SmsFailureKind, message: string, cause?: unknown): AppError {
  return new AppError(ERROR_CODE_BY_KIND[kind], message, {
    fields: { [SMS_FAILURE_FIELD]: kind },
    ...(cause !== undefined ? { cause } : {}),
  })
}

export function smsFailureKind(err: unknown): SmsFailureKind | null {
  if (typeof err !== "object" || err === null) return null
  const fields = (err as { fields?: unknown }).fields
  if (typeof fields !== "object" || fields === null) return null
  const value = (fields as Record<string, unknown>)[SMS_FAILURE_FIELD]
  if (typeof value !== "string") return null
  return (SMS_FAILURE_KINDS as readonly string[]).includes(value)
    ? (value as SmsFailureKind)
    : null
}

export function isRetryableSmsFailure(err: unknown): boolean {
  return smsFailureKind(err) === "temporary"
}
