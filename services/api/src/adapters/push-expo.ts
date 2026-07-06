import type { PushLogger, PlatformDispatcher } from "./push-sender.js"


export interface ExpoPushConfig {
  accessToken?: string
  endpoint?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

const EXPO_PUSH_ENDPOINT = "https://exp.host/--/api/v2/push/send"
const EXPO_CHUNK = 100
const EXPO_TIMEOUT_MS = 4000

export function isExpoPushToken(token: string): boolean {
  return token.startsWith("ExponentPushToken[") || token.startsWith("ExpoPushToken[")
}

interface ExpoTicket {
  status?: string
  message?: string
  details?: { error?: string }
}

export function makeExpoDispatcher(config: ExpoPushConfig, logger: PushLogger): PlatformDispatcher {
  const endpoint = config.endpoint ?? EXPO_PUSH_ENDPOINT
  const timeoutMs = config.timeoutMs ?? EXPO_TIMEOUT_MS
  const doFetch = config.fetchImpl ?? fetch

  const dispatch: PlatformDispatcher = async (tokens, payload) => {
    const invalidTokens: string[] = []
    const data = {
      ...(payload.data ?? {}),
      ...(payload.link !== undefined ? { link: payload.link } : {}),
    }
    const hasData = Object.keys(data).length > 0

    for (let i = 0; i < tokens.length; i += EXPO_CHUNK) {
      const chunk = tokens.slice(i, i + EXPO_CHUNK)
      const messages = chunk.map((to) => ({
        to,
        title: payload.title,
        ...(payload.body !== undefined ? { body: payload.body } : {}),
        sound: "default",
        ...(hasData ? { data } : {}),
      }))
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const res = await doFetch(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            ...(config.accessToken ? { authorization: `Bearer ${config.accessToken}` } : {}),
          },
          body: JSON.stringify(messages),
          signal: controller.signal,
        })
        if (!res.ok) {
          logger.error({ status: res.status, count: chunk.length }, "push(expo): HTTP error")
          continue
        }
        const json = (await res.json()) as { data?: ExpoTicket[] }
        const tickets = json.data ?? []
        tickets.forEach((ticket, idx) => {
          if (ticket?.status !== "error") return
          const token = chunk[idx]
          if (ticket.details?.error === "DeviceNotRegistered" && typeof token === "string") {
            invalidTokens.push(token)
          } else {
            logger.warn(
              { error: ticket.details?.error, message: ticket.message },
              "push(expo): ticket error",
            )
          }
        })
      } catch (err) {
        logger.error({ err }, "push(expo): send threw")
      } finally {
        clearTimeout(timer)
      }
    }
    return { invalidTokens }
  }

  return dispatch
}
