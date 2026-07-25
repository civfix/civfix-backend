import type { PushSenderConfig, PushLogger, PlatformDispatcher } from "./push-sender.js"
import { resolveSafePushTarget, parseSubscription } from "./push-sender.js"
import { mapWithLimit } from "../services/media-presign.js"
import { Agent } from "node:https"

/** Ceiling on cached agents. One per resolved push-service IP; the LRU tail is evicted past it. */
const AGENT_CACHE_MAX = 64
/** Idle keep-alive sockets are reaped after this long; does NOT apply to a socket mid-request. */
const AGENT_SOCKET_IDLE_MS = 30_000
/** How often a parked (evicted-but-still-busy) agent is re-checked for having drained. */
const AGENT_DRAIN_SWEEP_MS = 5_000

/** The pinned-agent pool: an LRU of https.Agents, plus the drain queue for evicted-but-busy ones. */
export interface PinnedAgentPool {
  /** The agent to use for a connection to this exact address (cached; refreshes LRU recency). */
  get(address: string, family: 4 | 6): Agent
  /** Destroy any parked agent that has finished its work. Idempotent; the timer calls it for you. */
  sweep(): void
  /** Shutdown: destroy every agent, cached or parked, and stop the drain timer. */
  destroyAll(): void
  /** Observability/test seam: `cached` = live LRU entries, `retiring` = parked, not yet drained. */
  stats(): { cached: number; retiring: number }
}

/**
 * In-flight work on an agent: sockets currently serving a request, plus requests still queued for one.
 * FREE (keep-alive, idle) sockets are deliberately not counted — destroying those breaks nothing.
 */
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

/**
 * Build a pool of https.Agents whose DNS resolution is PINNED to an address we already validated as
 * public, so the actual connection cannot be re-resolved to an internal one (DNS-rebinding SSRF).
 *
 * ONE implementation, used by the module-level singleton below and driven directly by the unit tests
 * (a second, test-only copy of an eviction policy is exactly how the policy drifts).
 *
 * Two properties are load-bearing, and the first version of this cache got both wrong:
 *
 *   1. The agents are `keepAlive: true`. Without it a cached agent still opened a fresh TCP+TLS
 *      connection per notification, so the cache bought NOTHING: the only reason to keep an agent alive
 *      across sends is to keep its SOCKETS alive across sends. `timeout` reaps an idle keep-alive socket
 *      (node destroys a socket that times out while it sits in the free list and ignores the timeout on
 *      one that is mid-request), so a push-service address that goes quiet does not hold a socket open.
 *
 *   2. Eviction NEVER destroys an agent that is still working. `Agent.destroy()` walks `sockets` as well
 *      as `freeSockets`, so the original "cache full -> destroy them all" flush aborted the in-flight
 *      pushes of the other WEB_PUSH_CONCURRENCY - 1 sends (ECONNRESET, warned about and dropped — this
 *      dispatcher does not retry, so those notifications are simply lost). Eviction is LRU and one agent
 *      at a time: destroyed immediately when idle, otherwise parked and destroyed once it has drained.
 *      Hitting the ceiling is realistic rather than theoretical — the target IP is re-resolved per
 *      subscription and the big push services round-robin over many addresses.
 */
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

  /** Destroy an evicted agent now if idle; otherwise let it finish and destroy it when it drains. */
  function retire(agent: Agent): void {
    if (inFlightCount(agent) === 0) {
      agent.destroy()
      return
    }
    retiring.add(agent)
    if (drainTimer === undefined) {
      drainTimer = setInterval(sweep, sweepMs)
      // Never hold the process (or a test runner) open just to reap a socket.
      drainTimer.unref?.()
    }
  }

  function get(address: string, family: 4 | 6): Agent {
    const key = `${family}|${address}`
    const cached = cache.get(key)
    if (cached) {
      // Map iteration order is insertion order, so re-inserting is what makes this key most-recently-used.
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
      // Shutdown: there is no in-flight push left worth protecting, so parked agents go too.
      for (const agent of retiring) agent.destroy()
      retiring.clear()
      if (drainTimer !== undefined) {
        clearInterval(drainTimer)
        drainTimer = undefined
      }
    },
  }
}

/** One pinned-agent pool per process, shared by every web-push dispatcher the container builds. */
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
          { endpoint: subscription.endpoint },
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
          logger.warn({ err, statusCode }, "push(webpush): delivery failure")
        }
      }
    })
    return { invalidTokens }
  }

  // Release the pinned agents on container close so no cached agent (or keep-alive socket) outlives the
  // sender. This is the shutdown path, so unlike eviction it does not wait for a drain.
  dispatch.close = async () => {
    agentPool.destroyAll()
  }

  return dispatch
}

/**
 * Classify a web-push send failure. 404/410 from a push service mean the subscription is permanently gone,
 * so the token is pruned; everything else is transient and only warned about. Pure + exported so the
 * prune-vs-warn matrix is unit-testable without the web-push SDK.
 */
export function classifyWebPushError(err: unknown): {
  prune: boolean
  statusCode: number | undefined
} {
  const raw = typeof err === "object" && err !== null ? (err as { statusCode?: unknown }).statusCode : undefined
  const statusCode = typeof raw === "number" ? raw : undefined
  return { prune: statusCode === 404 || statusCode === 410, statusCode }
}
