import type { PushPayload } from "@civfix/shared/interfaces"
import type { PushSenderConfig, PushLogger, PlatformDispatcher } from "./push-sender.js"
import { hashForLog } from "./push-sender.js"

const FCM_MULTICAST_MAX = 500

const PRUNE_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
  "messaging/invalid-argument",
])

export function isFcmPruneCode(code: string): boolean {
  return PRUNE_CODES.has(code)
}

export function makeFcmDispatcher(
  fcm: NonNullable<PushSenderConfig["fcm"]>,
  logger: PushLogger,
): PlatformDispatcher {
  const appName = "civfix-push"
  let initPromise: Promise<{ messaging: any; deleteApp: () => Promise<void> }> | null = null

  async function getMessaging() {
    if (!initPromise) {
      initPromise = (async () => {
        const admin = await import("firebase-admin/app")
        const messaging = await import("firebase-admin/messaging")
        const serviceAccount = JSON.parse(fcm.serviceAccountJson) as Record<string, unknown>
        const existing = admin.getApps().find((a) => a.name === appName)
        const app =
          existing ??
          admin.initializeApp(
            {
              credential: admin.cert(serviceAccount as never),
              ...(fcm.projectId !== undefined ? { projectId: fcm.projectId } : {}),
            },
            appName,
          )
        return { messaging: messaging.getMessaging(app), deleteApp: () => admin.deleteApp(app) }
      })()
    }
    return (await initPromise).messaging
  }

  async function dispatchSlice(
    messaging: any,
    tokens: string[],
    payload: PushPayload,
    invalidTokens: string[],
  ): Promise<void> {
    const message = {
      tokens,
      notification: {
        title: payload.title,
        ...(payload.body !== undefined ? { body: payload.body } : {}),
      },
      data: stringifyData({
        ...(payload.data ?? {}),
        ...(payload.link !== undefined ? { link: payload.link } : {}),
      }),
    }
    try {
      const resp = await messaging.sendEachForMulticast(message)
      resp.responses.forEach((r: { success: boolean; error?: { code?: string } }, i: number) => {
        if (r.success) return
        const code: string = r.error?.code ?? ""
        if (isFcmPruneCode(code)) {
          const tok = tokens[i]
          if (tok !== undefined) invalidTokens.push(tok)
        } else {
          const tok = tokens[i]
          logger.warn(
            { code, tokenHash: typeof tok === "string" ? hashForLog(tok) : undefined },
            "push(fcm): delivery failure",
          )
        }
      })
    } catch (err) {
      logger.error({ err }, "push(fcm): send threw")
    }
  }

  const dispatch: PlatformDispatcher = async (tokens, payload) => {
    const messaging = await getMessaging()
    const invalidTokens: string[] = []
    for (let i = 0; i < tokens.length; i += FCM_MULTICAST_MAX) {
      await dispatchSlice(messaging, tokens.slice(i, i + FCM_MULTICAST_MAX), payload, invalidTokens)
    }
    return { invalidTokens }
  }

  dispatch.close = async () => {
    if (!initPromise) return
    try {
      const { deleteApp } = await initPromise
      await deleteApp()
    } catch (err) {
      logger.warn({ err }, "push(fcm): app delete failed")
    }
  }

  return dispatch
}

function stringifyData(data: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(data)) {
    out[k] = typeof v === "string" ? v : JSON.stringify(v)
  }
  return out
}
