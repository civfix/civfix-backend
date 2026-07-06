import type { PushSenderConfig, PushLogger, PlatformDispatcher } from "./push-sender.js"
import { resolveSafePushTarget, parseSubscription } from "./push-sender.js"
import { mapWithLimit } from "../services/media-presign.js"
import { Agent } from "node:https"

function pinnedAgent(address: string, family: 4 | 6): Agent {
  return new Agent({
    lookup: (_hostname, options, callback) => {
      if (typeof options === "object" && options?.all) {
        ;(callback as (err: null, addrs: { address: string; family: number }[]) => void)(null, [
          { address, family },
        ])
      } else {
        ;(callback as (err: null, address: string, family: number) => void)(null, address, family)
      }
    },
  })
}

const WEB_PUSH_CONCURRENCY = 16

export function makeWebPushDispatcher(
  webPush: NonNullable<PushSenderConfig["webPush"]>,
  logger: PushLogger,
): PlatformDispatcher {
  let webpushPromise: Promise<any> | null = null

  async function getWebPush() {
    if (!webpushPromise) {
      webpushPromise = (async () => {
        const mod = await import("web-push")
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
        invalidTokens.push(token)
        return
      }
      const target = await resolveSafePushTarget(subscription.endpoint)
      if (target === null) {
        logger.warn(
          { endpoint: subscription.endpoint },
          "push(webpush): refusing unsafe/internal endpoint; pruning",
        )
        invalidTokens.push(token)
        return
      }
      try {
        await wp.sendNotification(subscription, body, {
          agent: pinnedAgent(target.address, target.family),
        })
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
