import type { PushPayload } from "@civfix/shared/interfaces"
import type { PushSenderConfig, PushLogger, PlatformDispatcher } from "./push-sender.js"

// sendEachForMulticast rejects the WHOLE batch with invalid-argument when tokens.length > 500, so we
// chunk and dispatch each slice independently.
const FCM_MULTICAST_MAX = 500

/** FCM error codes that mean "this token is dead; stop sending to it". */
const PRUNE_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
  "messaging/invalid-argument",
])

/**
 * True when the FCM per-token error code means the token is dead and must be pruned (vs a transient failure
 * we only warn about). Pure + exported so the prune-vs-warn matrix is unit-testable without firebase-admin.
 */
export function isFcmPruneCode(code: string): boolean {
  return PRUNE_CODES.has(code)
}

/**
 * FCM dispatcher (firebase-admin). Initializes a NAMED app once (memoized) from the service-account JSON so
 * it never clashes with any other firebase usage. Chunks tokens into ≤500 slices, maps each slice's
 * responses to the prune set.
 *
 * SEAM RULE: firebase-admin may ONLY be imported here, via lazy dynamic import.
 */
export function makeFcmDispatcher(
  fcm: NonNullable<PushSenderConfig["fcm"]>,
  logger: PushLogger,
): PlatformDispatcher {
  // Loose type: firebase-admin is dynamically imported; we only call getMessaging/sendEachForMulticast.
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
      // responses[] aligns 1:1 with tokens[]; map failed indices with a prune-worthy code to their token.
      resp.responses.forEach((r: { success: boolean; error?: { code?: string } }, i: number) => {
        if (r.success) return
        const code: string = r.error?.code ?? ""
        if (isFcmPruneCode(code)) {
          const tok = tokens[i]
          if (tok !== undefined) invalidTokens.push(tok)
        } else {
          logger.warn({ code, token: tokens[i] }, "push(fcm): delivery failure")
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

  // Delete the named app on container close so firebase-admin's keep-alive connection doesn't pin the
  // event loop. No-op if the app was never initialized.
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

/** Coerce a data bag to the all-string map FCM requires (non-strings are JSON-encoded). */
function stringifyData(data: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(data)) {
    out[k] = typeof v === "string" ? v : JSON.stringify(v)
  }
  return out
}
