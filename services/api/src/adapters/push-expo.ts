import type { PushLogger, PlatformDispatcher } from "./push-sender.js"

/**
 * Expo Push dispatcher.
 *
 * The community mobile app is Expo-managed: it registers an EXPO push token (`ExponentPushToken[...]`)
 * minted by `expo-notifications` getExpoPushTokenAsync — NOT a raw APNs/FCM device token. Such tokens can
 * only be delivered through Expo's push service (https://exp.host/--/api/v2/push/send), which fans the
 * message out to APNs (iOS) and FCM (Android) on our behalf. The raw APNs/FCM dispatchers therefore CANNOT
 * deliver to these tokens (APNs rejects them as BadDeviceToken), which is why iOS/Android push never
 * arrived. This dispatcher closes that gap: one dispatcher serves BOTH iOS and Android Expo tokens.
 *
 * SEAM: no vendor SDK — a plain HTTPS POST via the global `fetch`, so DI wiring stays dependency-free and
 * the routing/pruning logic is unit-tested with `fetch` stubbed. Tokens Expo reports as
 * `DeviceNotRegistered` are returned as invalid for pruning (mirrors the APNs `Unregistered` handling).
 */

export interface ExpoPushConfig {
  /** [OPT] Expo access token. Expo push works WITHOUT it; set it for enhanced push security. */
  accessToken?: string
  /** Override the endpoint (tests). Defaults to the Expo push API. */
  endpoint?: string
  /** Injected fetch (tests). Defaults to the global fetch. */
  fetchImpl?: typeof fetch
}

const EXPO_PUSH_ENDPOINT = "https://exp.host/--/api/v2/push/send"
/** Expo accepts up to 100 messages per request; chunk larger token sets. */
const EXPO_CHUNK = 100

/** True for an Expo push token (`ExponentPushToken[...]` or `ExpoPushToken[...]`). */
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
  const doFetch = config.fetchImpl ?? fetch

  const dispatch: PlatformDispatcher = async (tokens, payload) => {
    const invalidTokens: string[] = []
    // The mobile client reads the deep-link target off `data.link`; merge the payload link in like APNs.
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
      try {
        const res = await doFetch(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            ...(config.accessToken ? { authorization: `Bearer ${config.accessToken}` } : {}),
          },
          body: JSON.stringify(messages),
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
        // A transport failure for one chunk must not break the others or the caller.
        logger.error({ err }, "push(expo): send threw")
      }
    }
    return { invalidTokens }
  }

  return dispatch
}
