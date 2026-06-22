import type { PushSenderConfig, PushLogger, PlatformDispatcher } from "./push-sender.js"
import { isSafePushEndpoint, parseSubscription } from "./push-sender.js"
import { mapWithLimit } from "../services/media-presign.js"

// Cap concurrent server-side HTTPS POSTs (one per subscription) so a large recipient fan-out can't open
// hundreds of sockets at once.
const WEB_PUSH_CONCURRENCY = 16

/**
 * Web Push dispatcher (web-push). Sets VAPID details once (memoized). Each token is a JSON-encoded
 * PushSubscription string (what the browser's pushManager.subscribe() yields, persisted as the token). A
 * 404/410 from the push service means the subscription is gone => prune.
 *
 * SEAM RULE: web-push may ONLY be imported here, via lazy dynamic import.
 */
export function makeWebPushDispatcher(
  webPush: NonNullable<PushSenderConfig["webPush"]>,
  logger: PushLogger,
): PlatformDispatcher {
  // Loose type: web-push is dynamically imported; we only call setVapidDetails + sendNotification.
  let webpushPromise: Promise<any> | null = null

  async function getWebPush() {
    if (!webpushPromise) {
      webpushPromise = (async () => {
        const mod = await import("web-push")
        // @types/web-push exports a namespace; the default export carries the functions at runtime.
        const wp: any = (mod as { default?: unknown }).default ?? mod
        wp.setVapidDetails(webPush.subject, webPush.publicKey, webPush.privateKey)
        return wp
      })()
    }
    return webpushPromise
  }

  return async (tokens, payload) => {
    const wp = await getWebPush()
    const body = JSON.stringify({
      title: payload.title,
      ...(payload.body !== undefined ? { body: payload.body } : {}),
      ...(payload.link !== undefined ? { link: payload.link } : {}),
      data: payload.data ?? {},
    })

    const invalidTokens: string[] = []
    await mapWithLimit(tokens, WEB_PUSH_CONCURRENCY, async (token) => {
      const subscription = parseSubscription(token)
      if (subscription === null) {
        invalidTokens.push(token) // not a valid subscription JSON => useless, prune it
        return
      }
      // SECURITY (SSRF): the endpoint is attacker-controlled (any authed user registers it) and web-push
      // does a server-side POST to it. Resolve-then-validate refuses + prunes endpoints that resolve to
      // internal/loopback/link-local (incl. 169.254.169.254 IMDS)/CGNAT/ULA addresses so the API host
      // cannot probe/forge requests against the internal network (DNS-rebind defense).
      if (!(await isSafePushEndpoint(subscription.endpoint))) {
        logger.warn(
          { endpoint: subscription.endpoint },
          "push(webpush): refusing unsafe/internal endpoint; pruning",
        )
        invalidTokens.push(token)
        return
      }
      try {
        await wp.sendNotification(subscription, body)
      } catch (err) {
        const statusCode = (err as { statusCode?: number }).statusCode
        if (statusCode === 404 || statusCode === 410) {
          invalidTokens.push(token)
        } else {
          logger.warn({ err, statusCode }, "push(webpush): delivery failure")
        }
      }
    })
    return { invalidTokens }
  }
}
