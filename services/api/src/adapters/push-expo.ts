import type { PushLogger, PlatformDispatcher } from "./push-sender.js"
import { fetchJsonWithTimeout, type FetchJsonResult } from "./http-fetch.js"
import { sleep } from "../lib/sleep.js"
import { mapWithLimit } from "../lib/concurrency.js"

export interface ExpoPushConfig {
  accessToken?: string
  endpoint?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
  /** Jitter is added on top. */
  retryDelayMs?: number
}

const EXPO_PUSH_ENDPOINT = "https://exp.host/--/api/v2/push/send"
const EXPO_CHUNK = 100
const EXPO_TIMEOUT_MS = 4000
const EXPO_SPLIT_CONCURRENCY = 8
/** Expo asks senders to back off and retry a 429 / 5xx rather than dropping the batch. */
const EXPO_RETRY_DELAY_MS = 250
const EXPO_SOUND = "default"
const EXPO_TOKEN_PREFIXES = ["ExponentPushToken[", "ExpoPushToken["] as const
const EXPO_UNREGISTERED_ERROR = "DeviceNotRegistered"

const HTTP_TOO_MANY_REQUESTS = 429
const HTTP_SERVER_ERROR_MIN = 500

function isRetryableStatus(status: number): boolean {
  return status === HTTP_TOO_MANY_REQUESTS || status >= HTTP_SERVER_ERROR_MIN
}

export function isExpoPushToken(token: string): boolean {
  return EXPO_TOKEN_PREFIXES.some((prefix) => token.startsWith(prefix))
}

export interface ExpoTicket {
  status?: string
  message?: string
  details?: { error?: string }
}

/**
 * Only DeviceNotRegistered prunes a token; every other ticket error is logged. `tickets` is index-aligned
 * with `chunk`.
 */
export function collectExpoInvalidTokens(
  tickets: readonly ExpoTicket[],
  chunk: readonly string[],
  logger: PushLogger,
): string[] {
  const invalid: string[] = []
  tickets.forEach((ticket, idx) => {
    if (ticket?.status !== "error") return
    const token = chunk[idx]
    if (ticket.details?.error === EXPO_UNREGISTERED_ERROR && typeof token === "string") {
      invalid.push(token)
    } else {
      logger.warn(
        { error: ticket.details?.error, message: ticket.message },
        "push(expo): ticket error",
      )
    }
  })
  return invalid
}

export function makeExpoDispatcher(config: ExpoPushConfig, logger: PushLogger): PlatformDispatcher {
  const endpoint = config.endpoint ?? EXPO_PUSH_ENDPOINT
  const timeoutMs = config.timeoutMs ?? EXPO_TIMEOUT_MS
  // Left undefined when not injected so the helper resolves globalThis.fetch at CALL time.
  const doFetch = config.fetchImpl
  const retryDelayMs = config.retryDelayMs ?? EXPO_RETRY_DELAY_MS

  const dispatch: PlatformDispatcher = async (tokens, payload) => {
    const invalidTokens: string[] = []
    const data = {
      ...(payload.data ?? {}),
      ...(payload.link !== undefined ? { link: payload.link } : {}),
    }
    const hasData = Object.keys(data).length > 0

    const sendChunk = async (
      chunk: string[],
    ): Promise<FetchJsonResult<{ data?: ExpoTicket[] }>> => {
      const messages = chunk.map((to) => ({
        to,
        title: payload.title,
        ...(payload.body !== undefined ? { body: payload.body } : {}),
        sound: EXPO_SOUND,
        ...(hasData ? { data } : {}),
      }))
      const send = (): Promise<FetchJsonResult<{ data?: ExpoTicket[] }>> =>
        fetchJsonWithTimeout<{ data?: ExpoTicket[] }>(endpoint, {
          timeoutMs,
          ...(doFetch !== undefined ? { fetchImpl: doFetch } : {}),
          init: {
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "application/json",
              ...(config.accessToken ? { authorization: `Bearer ${config.accessToken}` } : {}),
            },
            body: JSON.stringify(messages),
          },
        })

      let result = await send()
      if (!result.ok && result.kind === "http" && isRetryableStatus(result.status)) {
        await sleep(retryDelayMs + Math.floor(Math.random() * retryDelayMs))
        result = await send()
      }
      return result
    }

    const deliverChunk = async (chunk: string[]): Promise<void> => {
      const result = await sendChunk(chunk)
      if (result.ok) {
        for (const token of collectExpoInvalidTokens(result.json.data ?? [], chunk, logger)) {
          invalidTokens.push(token)
        }
        return
      }
      if (result.kind === "http" && result.status === 400 && chunk.length > 1) {
        logger.warn({ count: chunk.length }, "push(expo): batch rejected; resending per token")
        await mapWithLimit(chunk, EXPO_SPLIT_CONCURRENCY, (token) => deliverChunk([token]))
        return
      }
      if (result.kind === "http") {
        logger.error({ status: result.status, count: chunk.length }, "push(expo): HTTP error")
      } else {
        logger.error({ err: result.error }, "push(expo): send threw")
      }
    }

    for (let i = 0; i < tokens.length; i += EXPO_CHUNK) {
      await deliverChunk(tokens.slice(i, i + EXPO_CHUNK))
    }
    return { invalidTokens }
  }

  return dispatch
}
