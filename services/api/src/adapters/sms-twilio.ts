import type { SentSms, SmsSender } from "@civfix/shared/interfaces"
import type { AppError } from "@civfix/shared"
import { smsFailure } from "../errors/sms-failure.js"

const TWILIO_API_ROOT = "https://api.twilio.com/2010-04-01/Accounts"

export const SMS_SEND_TIMEOUT_MS = 10_000

export const TWILIO_OPTED_OUT_CODE = 21610

export const TWILIO_INVALID_NUMBER_CODES: ReadonlySet<number> = new Set([21211, 21614])

const MAX_ERROR_BODY_BYTES = 64 * 1024

export interface TwilioSmsSenderConfig {
  accountSid: string
  authToken: string
  from: string
  fetchImpl?: typeof fetch
}

interface TwilioMessageResponse {
  sid?: unknown
  code?: unknown
  message?: unknown
}

export class TwilioSmsSender implements SmsSender {
  private readonly config: TwilioSmsSenderConfig

  constructor(config: TwilioSmsSenderConfig) {
    this.config = config
  }

  async send(to: string, body: string): Promise<SentSms> {
    const doFetch = this.config.fetchImpl ?? globalThis.fetch
    const url = `${TWILIO_API_ROOT}/${encodeURIComponent(this.config.accountSid)}/Messages.json`
    const credentials = Buffer.from(
      `${this.config.accountSid}:${this.config.authToken}`,
      "utf8",
    ).toString("base64")
    const form = new URLSearchParams({ To: to, From: this.config.from, Body: body })

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), SMS_SEND_TIMEOUT_MS)
    try {
      let response: Response
      try {
        response = await doFetch(url, {
          method: "POST",
          redirect: "error",
          headers: {
            authorization: `Basic ${credentials}`,
            "content-type": "application/x-www-form-urlencoded",
            accept: "application/json",
          },
          body: form.toString(),
          signal: controller.signal,
        })
      } catch (err) {
        throw smsFailure(
          "temporary",
          "Text message not sent: the SMS provider did not respond in time.",
          err,
        )
      }

      const read = await readJsonPayload(response, controller.signal)
      if (!response.ok) {
        throw classifyTwilioError(response.status, read.payload)
      }
      if (read.interrupted) {
        // A 2xx status means Twilio may already have queued the text, so retrying could send it twice.
        throw smsFailure(
          "permanent",
          "Text message status unknown: the SMS provider accepted it but its reply was cut off.",
          read.error,
        )
      }
      const sid = typeof read.payload.sid === "string" ? read.payload.sid : ""
      if (sid === "") {
        throw smsFailure(
          "temporary",
          "Text message not sent: the SMS provider returned no message id.",
        )
      }
      return { id: sid }
    } finally {
      clearTimeout(timer)
    }
  }
}

interface PayloadRead {
  payload: TwilioMessageResponse
  interrupted: boolean
  error?: unknown
}

async function readJsonPayload(response: Response, signal: AbortSignal): Promise<PayloadRead> {
  const declared = Number(response.headers?.get?.("content-length") ?? "")
  if (Number.isFinite(declared) && declared > MAX_ERROR_BODY_BYTES) {
    await response.body?.cancel().catch(() => {})
    return { payload: {}, interrupted: false }
  }
  const body = response.body
  if (body === null) return { payload: {}, interrupted: false }

  const reader = body.getReader()
  const cancelOnAbort = () => {
    void reader.cancel().catch(() => {})
  }
  signal.addEventListener("abort", cancelOnAbort, { once: true })
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    if (signal.aborted) cancelOnAbort()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_ERROR_BODY_BYTES) {
        await reader.cancel().catch(() => {})
        return { payload: {}, interrupted: false }
      }
      chunks.push(value)
    }
  } catch (error) {
    return { payload: {}, interrupted: true, error }
  } finally {
    signal.removeEventListener("abort", cancelOnAbort)
    reader.releaseLock()
  }
  if (signal.aborted) return { payload: {}, interrupted: true, error: signal.reason }

  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    const payload =
      typeof parsed === "object" && parsed !== null ? (parsed as TwilioMessageResponse) : {}
    return { payload, interrupted: false }
  } catch {
    // A gateway's HTML error page still classifies by HTTP status alone.
    return { payload: {}, interrupted: false }
  }
}

export function classifyTwilioError(status: number, payload: TwilioMessageResponse): AppError {
  const providerCode = typeof payload.code === "number" ? payload.code : undefined
  const detail = providerCode !== undefined ? ` (provider code ${providerCode})` : ""

  if (providerCode === TWILIO_OPTED_OUT_CODE) {
    return smsFailure(
      "opted_out",
      `Text message not sent: this number has replied STOP and is opted out.${detail}`,
    )
  }
  if (providerCode !== undefined && TWILIO_INVALID_NUMBER_CODES.has(providerCode)) {
    return smsFailure(
      "invalid_number",
      `Text message not sent: that phone number is not a valid mobile number.${detail}`,
    )
  }
  if (status === 429 || status >= 500) {
    return smsFailure(
      "temporary",
      `Text message not sent: the SMS provider is temporarily unavailable.${detail}`,
    )
  }
  return smsFailure("permanent", `Text message not sent: the SMS provider rejected it.${detail}`)
}
