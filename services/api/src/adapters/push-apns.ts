import type { PushSenderConfig, PushLogger, PlatformDispatcher } from "./push-sender.js"
import { hashForLog } from "./push-sender.js"

export function isApnsPruneFailure(status: string, reason: string): boolean {
  return status === "410" || reason === "Unregistered" || reason === "BadDeviceToken"
}

export function makeApnsDispatcher(
  apns: NonNullable<PushSenderConfig["apns"]>,
  logger: PushLogger,
): PlatformDispatcher {
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
      for (const failure of result.failed ?? []) {
        const status = String(failure.status ?? "")
        const reason = failure.response?.reason ?? ""
        if (isApnsPruneFailure(status, reason)) {
          if (typeof failure.device === "string") invalidTokens.push(failure.device)
        } else {
          logger.warn(
            {
              status,
              reason,
              deviceHash: typeof failure.device === "string" ? hashForLog(failure.device) : undefined,
            },
            "push(apns): delivery failure",
          )
        }
      }
    } catch (err) {
      logger.error({ err }, "push(apns): send threw")
    }
    return { invalidTokens }
  }

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
