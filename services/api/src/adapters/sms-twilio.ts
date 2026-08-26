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
    } finally {
      clearTimeout(timer)
    }

    const payload = await readJsonPayload(response)
    if (!response.ok) {
      throw classifyTwilioError(response.status, payload)
    }
    const sid = typeof payload.sid === "string" ? payload.sid : ""
    if (sid === "") {
      throw smsFailure("temporary", "Text message not sent: the SMS provider returned no message id.")
    }
    return { id: sid }
  }
}

async function readJsonPayload(response: Response): Promise<TwilioMessageResponse> {
  const declared = Number(response.headers?.get?.("content-length") ?? "")
  if (Number.isFinite(declared) && declared > MAX_ERROR_BODY_BYTES) {
    await response.body?.cancel().catch(() => {})
    return {}
  }
  try {
    const parsed: unknown = await response.json()
    return typeof parsed === "object" && parsed !== null ? (parsed as TwilioMessageResponse) : {}
  } catch {
    return {}
  }
}

export function classifyTwilioError(status: number, payload: TwilioMessageResponse): AppError {
  const providerCode = typeof payload.code === "number" ? payload.code : undefined
  const providerMessage = typeof payload.message === "string" ? payload.message : undefined
  const detail = providerMessage !== undefined ? ` (${providerMessage})` : ""

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
