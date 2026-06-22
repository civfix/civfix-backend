import type { PushSenderConfig, PushLogger, PlatformDispatcher } from "./push-sender.js"

/**
 * APNs dispatcher (node-apn). Builds a token-auth Provider once (memoized) on first send. Maps the payload
 * to an apn.Notification (alert title/body, topic = bundleId, data merged into the payload). Tokens whose
 * response status is 410 (Unregistered) or 400 with BadDeviceToken are reported invalid for pruning.
 *
 * SEAM RULE: node-apn may ONLY be imported here, via lazy dynamic import, so DI wiring loads no SDK and
 * opens no HTTP/2 connection until the first real send().
 */
export function makeApnsDispatcher(
  apns: NonNullable<PushSenderConfig["apns"]>,
  logger: PushLogger,
): PlatformDispatcher {
  // node-apn types are loose (any) here because the SDK is dynamically imported; we narrow what we touch.
  let providerPromise: Promise<{ provider: any; Notification: any }> | null = null

  async function getProvider() {
    if (!providerPromise) {
      providerPromise = (async () => {
        const apn = await import("node-apn")
        const provider = new apn.Provider({
          token: { key: apns.privateKey, keyId: apns.keyId, teamId: apns.teamId },
          production: apns.production,
        })
        return { provider, Notification: apn.Notification }
      })()
    }
    return providerPromise
  }

  const dispatch: PlatformDispatcher = async (tokens, payload) => {
    const { provider, Notification } = await getProvider()
    const note = new Notification()
    note.topic = apns.bundleId
    note.alert = {
      title: payload.title,
      ...(payload.body !== undefined ? { body: payload.body } : {}),
    }
    note.sound = "default"
    note.payload = {
      ...(payload.data ?? {}),
      ...(payload.link !== undefined ? { link: payload.link } : {}),
    }

    const invalidTokens: string[] = []
    try {
      const result = await provider.send(note, tokens)
      // result.failed carries per-token failures; 410 (Unregistered) / BadDeviceToken => prune.
      for (const failure of result.failed ?? []) {
        const status = String(failure.status ?? "")
        const reason = failure.response?.reason ?? ""
        if (status === "410" || reason === "Unregistered" || reason === "BadDeviceToken") {
          if (typeof failure.device === "string") invalidTokens.push(failure.device)
        } else {
          logger.warn({ status, reason, device: failure.device }, "push(apns): delivery failure")
        }
      }
    } catch (err) {
      logger.error({ err }, "push(apns): send threw")
    }
    return { invalidTokens }
  }

  // The Provider holds a long-lived HTTP/2 connection; shut it down on container close so it doesn't
  // keep the event loop alive on SIGTERM. No-op if the provider was never built.
  dispatch.close = async () => {
    if (!providerPromise) return
    try {
      const { provider } = await providerPromise
      provider.shutdown?.()
    } catch (err) {
      logger.warn({ err }, "push(apns): provider shutdown failed")
    }
  }

  return dispatch
}
