import { ErrorCode, type DeliveryFailureKind } from "@civfix/shared"

export interface MailFailure {
  kind: DeliveryFailureKind
  responseCode: number | undefined
  code: string | undefined
  response: string | undefined
  command: string | undefined
  senderRejected: boolean
}

const OVERSIZE_RESPONSE_RE =
  /message too large|size limit|exceed(?:s|ed)?\s+(?:the\s+)?(?:maximum\s+)?(?:message\s+)?size|too big/i

const RECIPIENT_RESPONSE_RE =
  /(?:recipient|rcpt)\b[^.\n]{0,24}(?:rejected|unknown|not found|unavailable|does not exist)|no such (?:user|mailbox|recipient|address)|(?:user|recipient|mailbox|address) unknown|unknown (?:user|recipient)|mailbox (?:unavailable|not found|does not exist|is full|full)|unrouteable address|\b5\.1\.\d/i

const TRANSIENT_SOCKET_CODES = new Set([
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ESOCKET",
  "EDNS",
  "EAI_AGAIN",
  "ECONNECTION",
])

const APP_ERROR_CODES: ReadonlySet<string> = new Set<string>(Object.values(ErrorCode))

const MAX_CAUSE_DEPTH = 4

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value === "string" ? value : undefined
}

function carriesSmtpSignal(source: Record<string, unknown>): boolean {
  if (typeof source.responseCode === "number") return true
  if (typeof source.response === "string") return true
  if (typeof source.command === "string") return true
  const code = source.code
  return typeof code === "string" && !APP_ERROR_CODES.has(code)
}

function smtpSource(err: unknown, depth = 0): Record<string, unknown> {
  if (typeof err !== "object" || err === null || depth > MAX_CAUSE_DEPTH) return {}
  const source = err as Record<string, unknown>
  const smtp = source.smtp
  if (typeof smtp === "object" && smtp !== null) return smtp as Record<string, unknown>
  if (carriesSmtpSignal(source)) return source
  return smtpSource(source.cause, depth + 1)
}

function isRecipientRejection(response: string | undefined): boolean {
  return response !== undefined && RECIPIENT_RESPONSE_RE.test(response)
}

export function mailFailure(err: unknown): MailFailure {
  const source = smtpSource(err)
  const rawResponseCode = source.responseCode
  const responseCode = typeof rawResponseCode === "number" ? rawResponseCode : undefined
  const rawCode = readString(source, "code")
  const code = rawCode !== undefined && APP_ERROR_CODES.has(rawCode) ? undefined : rawCode
  const response = readString(source, "response")
  const command = readString(source, "command")
  const base = { responseCode, code, response, command }

  if (code === "EAUTH") {
    return { ...base, kind: "auth", senderRejected: true }
  }

  if (
    responseCode === 552 ||
    responseCode === 523 ||
    (response !== undefined && OVERSIZE_RESPONSE_RE.test(response))
  ) {
    return { ...base, kind: "oversize", senderRejected: false }
  }

  if (responseCode !== undefined && responseCode >= 500 && responseCode < 600) {
    return isRecipientRejection(response)
      ? { ...base, kind: "permanent", senderRejected: false }
      : { ...base, kind: "auth", senderRejected: true }
  }

  if (responseCode !== undefined && responseCode >= 400 && responseCode < 500) {
    return { ...base, kind: "transient", senderRejected: false }
  }

  if (code !== undefined && TRANSIENT_SOCKET_CODES.has(code)) {
    return { ...base, kind: "transient", senderRejected: false }
  }

  return { ...base, kind: "unknown", senderRejected: false }
}

export function mailFailureKind(err: unknown): DeliveryFailureKind {
  return mailFailure(err).kind
}

export function isRetryableMailFailure(err: unknown): boolean {
  return mailFailureKind(err) === "transient"
}
