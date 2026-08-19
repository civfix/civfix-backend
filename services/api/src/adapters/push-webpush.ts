import type { PushSenderConfig, PushLogger, PlatformDispatcher } from "./push-sender.js"
import { resolveSafePushTarget, parseSubscription, hashForLog } from "./push-sender.js"
import { mapWithLimit } from "../services/media-presign.js"
import { Agent } from "node:https"

const AGENT_CACHE_MAX = 64
const AGENT_SOCKET_IDLE_MS = 30_000
const AGENT_DRAIN_SWEEP_MS = 5_000

export interface PinnedAgentPool {
  get(address: string, family: 4 | 6): Agent
  sweep(): void
  destroyAll(): void
  stats(): { cached: number; retiring: number }
}

function inFlightCount(agent: Agent): number {
  const groups = agent as unknown as {
    sockets?: Record<string, unknown[] | undefined>
    requests?: Record<string, unknown[] | undefined>
  }
  let n = 0
  for (const list of Object.values(groups.sockets ?? {})) n += list?.length ?? 0
  for (const list of Object.values(groups.requests ?? {})) n += list?.length ?? 0
  return n
}

export function makePinnedAgentPool(
  opts: { max?: number; sweepMs?: number } = {},
): PinnedAgentPool {
  const max = opts.max ?? AGENT_CACHE_MAX
  const sweepMs = opts.sweepMs ?? AGENT_DRAIN_SWEEP_MS
  const cache = new Map<string, Agent>()
  const retiring = new Set<Agent>()
  let drainTimer: ReturnType<typeof setInterval> | undefined

  function sweep(): void {
    for (const agent of retiring) {
      if (inFlightCount(agent) > 0) continue
      agent.destroy()
      retiring.delete(agent)
    }
    if (retiring.size === 0 && drainTimer !== undefined) {
      clearInterval(drainTimer)
      drainTimer = undefined
    }
  }

  function retire(agent: Agent): void {
    if (inFlightCount(agent) === 0) {
      agent.destroy()
      return
    }
    retiring.add(agent)
    if (drainTimer === undefined) {
      drainTimer = setInterval(sweep, sweepMs)
      drainTimer.unref?.()
    }
  }

  function get(address: string, family: 4 | 6): Agent {
    const key = `${family}|${address}`
    const cached = cache.get(key)
    if (cached) {
      cache.delete(key)
      cache.set(key, cached)
      return cached
    }
    const agent = new Agent({
      keepAlive: true,
      timeout: AGENT_SOCKET_IDLE_MS,
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
    while (cache.size >= max) {
      const lru = cache.keys().next()
      if (lru.done) break
      const evicted = cache.get(lru.value)
      cache.delete(lru.value)
      if (evicted) retire(evicted)
    }
    cache.set(key, agent)
    return agent
  }

  return {
    get,
    sweep,
    stats: () => ({ cached: cache.size, retiring: retiring.size }),
    destroyAll: () => {
      for (const agent of cache.values()) agent.destroy()
      cache.clear()
      for (const agent of retiring) agent.destroy()
      retiring.clear()
      if (drainTimer !== undefined) {
        clearInterval(drainTimer)
        drainTimer = undefined
      }
    },
  }
}

const agentPool = makePinnedAgentPool()

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

  const dispatch: PlatformDispatcher = async (tokens, payload) => {
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
          { endpointHash: hashForLog(subscription.endpoint) },
          "push(webpush): refusing unsafe/internal endpoint; pruning",
        )
        invalidTokens.push(token)
        return
      }
      try {
        await wp.sendNotification(subscription, body, {
          agent: agentPool.get(target.address, target.family),
        })
      } catch (err) {
        const { prune, statusCode } = classifyWebPushError(err)
        if (prune) {
          invalidTokens.push(token)
        } else {
          logger.warn(
            { statusCode, endpointHash: hashForLog(subscription.endpoint) },
            "push(webpush): delivery failure",
          )
        }
      }
    })
    return { invalidTokens }
  }

  dispatch.close = async () => {
    agentPool.destroyAll()
  }

  return dispatch
}

export function classifyWebPushError(err: unknown): {
  prune: boolean
  statusCode: number | undefined
} {
  const raw = typeof err === "object" && err !== null ? (err as { statusCode?: unknown }).statusCode : undefined
  const statusCode = typeof raw === "number" ? raw : undefined
  return { prune: statusCode === 404 || statusCode === 410, statusCode }
}
