import { encodePushMessageData } from "@civfix/contract"
import type { Messaging, TokenMessage } from "firebase-admin/messaging"
import type {
  PushSenderConfig,
  PushLogger,
  PlatformDispatcher,
  PushDelivery,
} from "./push-sender.js"
import { hashForLog } from "./push-sender.js"
import { androidChannelFor, pushMessageData } from "./push-message.js"

const FCM_SEND_EACH_MAX = 500

// Clears are background work, which Android delivers without waking a dozing device (D8).
const FCM_SILENT_PRIORITY = "normal"

const FCM_APP_NAME = "civfix-push"

const PRUNE_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
])

// FCM v1 answers both a malformed token and a bad payload (too large, reserved data key) with
// INVALID_ARGUMENT, so it only proves a token fault when another message in the same call got through.
const AMBIGUOUS_INVALID_CODE = "messaging/invalid-argument"

export function isFcmPruneCode(code: string): boolean {
  return PRUNE_CODES.has(code)
}

type FcmSendResponse = { success: boolean; error?: { code?: string; message?: string } }

interface FcmSliceVerdict {
  invalidTokens: string[]
  payloadRejected: { message: string | undefined } | null
  failures: { code: string; token: string | undefined }[]
}

function classifyFcmResponses(
  tokens: readonly string[],
  responses: readonly FcmSendResponse[],
): FcmSliceVerdict {
  const payloadAccepted = responses.some((r) => r.success)
  const verdict: FcmSliceVerdict = { invalidTokens: [], payloadRejected: null, failures: [] }
  responses.forEach((r, i) => {
    if (r.success) return
    const code = r.error?.code ?? ""
    const token = tokens[i]
    if (isFcmPruneCode(code) || (code === AMBIGUOUS_INVALID_CODE && payloadAccepted)) {
      if (token !== undefined) verdict.invalidTokens.push(token)
    } else if (code === AMBIGUOUS_INVALID_CODE) {
      verdict.payloadRejected ??= { message: r.error?.message }
    } else {
      verdict.failures.push({ code, token })
    }
  })
  return verdict
}

export function makeFcmDispatcher(
  fcm: NonNullable<PushSenderConfig["fcm"]>,
  logger: PushLogger,
): PlatformDispatcher {
  let initPromise: Promise<{ messaging: Messaging; deleteApp: () => Promise<void> }> | null = null

  async function getMessaging() {
    initPromise ??= (async () => {
      const admin = await import("firebase-admin/app")
      const messaging = await import("firebase-admin/messaging")
      const serviceAccount = JSON.parse(fcm.serviceAccountJson) as Record<string, unknown>
      const existing = admin.getApps().find((a) => a.name === FCM_APP_NAME)
      const app =
        existing ??
        admin.initializeApp(
          {
            credential: admin.cert(serviceAccount),
            ...(fcm.projectId !== undefined ? { projectId: fcm.projectId } : {}),
          },
          FCM_APP_NAME,
        )
      return { messaging: messaging.getMessaging(app), deleteApp: () => admin.deleteApp(app) }
    })()
    return (await initPromise).messaging
  }

  async function dispatchSlice(
    messaging: Messaging,
    slice: PushDelivery[],
    invalidTokens: string[],
  ): Promise<FcmSliceVerdict["payloadRejected"]> {
    const tokens = slice.map((d) => d.token)
    try {
      const resp = await messaging.sendEach(slice.map(fcmMessage))
      const verdict = classifyFcmResponses(tokens, resp.responses)
      invalidTokens.push(...verdict.invalidTokens)
      for (const { code, token } of verdict.failures) {
        logger.warn(
          { code, tokenHash: typeof token === "string" ? hashForLog(token) : undefined },
          "push(fcm): delivery failure",
        )
      }
      return verdict.payloadRejected
    } catch (err) {
      logger.error({ err }, "push(fcm): send threw")
      return null
    }
  }

  const dispatch: PlatformDispatcher = async (deliveries) => {
    const messaging = await getMessaging()
    const invalidTokens: string[] = []
    let payloadRejection: FcmSliceVerdict["payloadRejected"] = null
    let rejectedSlices = 0
    for (let i = 0; i < deliveries.length; i += FCM_SEND_EACH_MAX) {
      const rejection = await dispatchSlice(
        messaging,
        deliveries.slice(i, i + FCM_SEND_EACH_MAX),
        invalidTokens,
      )
      if (rejection !== null) {
        rejectedSlices += 1
        payloadRejection ??= rejection
      }
    }
    if (payloadRejection !== null) {
      logger.warn(
        { code: AMBIGUOUS_INVALID_CODE, detail: payloadRejection.message, rejectedSlices },
        "push(fcm): payload rejected for every token in a batch; no tokens pruned",
      )
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

// `channelId` is the Admin SDK's name for the v1 API's android.notification.channel_id. Stored android
// tokens are FCM registration tokens, not Firebase installation IDs; the FID message needs clients to
// register FIDs first.
// eslint-disable-next-line @typescript-eslint/no-deprecated
function fcmMessage({ token, message }: PushDelivery): TokenMessage {
  const data = encodePushMessageData(pushMessageData(message))
  if (message.kind === "clear") {
    return { token, data, android: { priority: FCM_SILENT_PRIORITY } }
  }
  const { payload } = message
  return {
    token,
    notification: {
      title: payload.title,
      ...(payload.body !== undefined ? { body: payload.body } : {}),
    },
    data,
    android: {
      notification: {
        tag: payload.notificationId,
        channelId: androidChannelFor(payload.category),
      },
    },
  }
}
