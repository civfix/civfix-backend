import type { Jobs, PushClearTarget, PushItem, PushPayload, PushSender } from "@civfix/seams"
import type { PushPlatform } from "@civfix/contract"
import type { Db } from "../db/client.js"
import { pushTokens } from "../db/schema/push_tokens.js"
import { and, desc, inArray, isNull } from "drizzle-orm"
import { makeApnsDispatcher } from "./push-apns.js"
import { makeFcmDispatcher } from "./push-fcm.js"
import { makeWebPushDispatcher } from "./push-webpush.js"
import type { NotificationMessage, PushMessage } from "./push-message.js"
import type { PendingClears } from "./push-clears.js"
import { mapWithLimit } from "../lib/concurrency.js"
import { sha256HexSync } from "../lib/hash.js"
import { PUSH_CLEAR_JOB } from "../lib/queue-names.js"
import type { CounterStore } from "../abuse/counter-store.js"
import { isExpoPushToken, type PushAddressResolver } from "../services/push-token-policy.js"

export type { ClearMessage, NotificationMessage, PushMessage } from "./push-message.js"

export interface PushSenderConfig {
  apns?: {
    keyId: string
    teamId: string
    privateKey: string
    bundleId: string
    production: boolean
  }
  fcm?: {
    serviceAccountJson: string
    projectId?: string
  }
  webPush?: {
    publicKey: string
    privateKey: string
    subject: string
    timeoutMs?: number
    batchBudgetMs?: number
    loadModule?: () => Promise<unknown>
    resolveAddresses?: PushAddressResolver
  }
}

export interface PushLogger {
  warn(obj: unknown, msg?: string): void
  error(obj: unknown, msg?: string): void
}

const LOG_HASH_HEX_CHARS = 12

export function hashForLog(value: string): string {
  return sha256HexSync(value).slice(0, LOG_HASH_HEX_CHARS)
}

const ACTIVE_TOKEN_SCAN_CAP_PER_USER = 20

// D7: one token query per this many recipients.
const TOKEN_QUERY_USER_BATCH = 500

// pg-boss holds the user's flush job this long, so every clear made meanwhile joins one push.
export const PUSH_CLEAR_DELAY_SECONDS = 10

// Only for callers that construct the sender without a logger; the API container always injects
// its pino logger so redaction and request context apply.
const consoleLogger: PushLogger = {
  warn: (obj, msg) => console.warn(msg ?? "", obj),
  error: (obj, msg) => console.error(msg ?? "", obj),
}

export interface ActiveToken {
  userId: string
  platform: PushPlatform
  token: string
}

export interface PushDelivery<M extends PushMessage = PushMessage> {
  token: string
  message: M
}

export interface PlatformDispatcher<M extends PushMessage = PushMessage> {
  (deliveries: PushDelivery<M>[]): Promise<{ invalidTokens: string[] }>
  close?(): Promise<void>
}

export interface PushDispatchers {
  ios?: PlatformDispatcher
  android?: PlatformDispatcher
  web?: PlatformDispatcher<NotificationMessage>
}

export interface PushClearDeps {
  jobs: Pick<Jobs, "enqueue">
  pending: PendingClears
}

interface PlatformDeliveries {
  ios: PushDelivery[]
  android: PushDelivery[]
  web: PushDelivery<NotificationMessage>[]
}

export interface PushSenderDeps {
  db: Db
  config: PushSenderConfig
  dispatchers?: PushDispatchers
  logger?: PushLogger
  counters?: CounterStore
  clears?: PushClearDeps
}

export interface PushClearJob {
  userId: string
}

interface RateBudget {
  keyPrefix: string
  capPerMinute: number
  label: string
}

export const PUSH_MAX_PER_USER_PER_MINUTE = 60

export const PUSH_CLEAR_MAX_PER_USER_PER_MINUTE = 30

const VISIBLE_BUDGET: RateBudget = {
  keyPrefix: "push:rate:",
  capPerMinute: PUSH_MAX_PER_USER_PER_MINUTE,
  label: "push",
}

// Clears never spend the visible budget, so reading a busy conversation can't mute new pushes (D8).
const CLEAR_BUDGET: RateBudget = {
  keyPrefix: "push:clear-rate:",
  capPerMinute: PUSH_CLEAR_MAX_PER_USER_PER_MINUTE,
  label: "clear push",
}

const PUSH_RATE_WINDOW_SECONDS = 60
const PUSH_RATE_CHECK_CONCURRENCY = 16

async function withinBudget(
  userIds: readonly string[],
  budget: RateBudget,
  counters: CounterStore | undefined,
  logger: PushLogger,
): Promise<boolean[]> {
  if (!counters) return userIds.map(() => true)
  const verdicts = await mapWithLimit(
    [...userIds],
    PUSH_RATE_CHECK_CONCURRENCY,
    async (userId): Promise<boolean> => {
      try {
        const used = await counters.incr(`${budget.keyPrefix}${userId}`, PUSH_RATE_WINDOW_SECONDS)
        return used <= budget.capPerMinute
      } catch (err) {
        logger.warn({ err }, `${budget.label}: per-user rate counter unavailable; allowing`)
        return true
      }
    },
  )
  const dropped = verdicts.filter((v) => !v).length
  if (dropped > 0) {
    logger.warn(
      { dropped, capPerMinute: budget.capPerMinute },
      `${budget.label}: per-user rate cap reached; dropping excess device pushes`,
    )
  }
  return verdicts
}

export async function allowedByPushRate(
  userIds: string[],
  counters: CounterStore | undefined,
  logger: PushLogger,
): Promise<string[]> {
  const verdicts = await withinBudget(userIds, VISIBLE_BUDGET, counters, logger)
  return userIds.filter((_, i) => verdicts[i] === true)
}

export class MultiPushSender implements PushSender {
  private readonly db: Db
  private readonly config: PushSenderConfig
  private readonly logger: PushLogger
  private readonly counters: CounterStore | undefined
  private readonly clears: PushClearDeps | undefined
  private dispatchers: PushDispatchers | undefined

  constructor(deps: PushSenderDeps) {
    this.db = deps.db
    this.config = deps.config
    this.logger = deps.logger ?? consoleLogger
    this.counters = deps.counters
    this.clears = deps.clears
    if (deps.dispatchers) this.dispatchers = deps.dispatchers
  }

  registerToken(
    _userId: string,
    _token: string,
    _platform: PushPlatform,
    _deviceId?: string,
  ): Promise<void> {
    return Promise.resolve()
  }

  send(userId: string, payload: PushPayload): Promise<void> {
    return this.sendEach([{ userId, payload }])
  }

  async sendEach(items: PushItem[]): Promise<void> {
    for (let i = 0; i < items.length; i += TOKEN_QUERY_USER_BATCH) {
      await this.deliverVisible(items.slice(i, i + TOKEN_QUERY_USER_BATCH))
    }
  }

  async clear(userId: string, target: PushClearTarget): Promise<void> {
    if (!this.clears) throw new Error("push clears need a job queue and a pending-clears store")
    if (!("all" in target) && target.ids.length === 0) return
    await this.clears.pending.add(userId, target)
    await this.clears.jobs.enqueue(PUSH_CLEAR_JOB, { userId } satisfies PushClearJob, {
      singletonKey: userId,
      startAfter: PUSH_CLEAR_DELAY_SECONDS,
    })
  }

  /** The clear job's work: one silent push to the user's phones with everything queued since. */
  async flushClears(userId: string): Promise<void> {
    if (!this.clears) throw new Error("push clears need a job queue and a pending-clears store")
    const target = await this.clears.pending.take(userId)
    if (target === null) return
    const [allowed] = await withinBudget([userId], CLEAR_BUDGET, this.counters, this.logger)
    if (allowed !== true) return
    const message: PushMessage = { kind: "clear", target }
    await this.dispatch(await this.loadActiveTokens([userId]), () => [message])
  }

  async close(): Promise<void> {
    if (!this.dispatchers) return
    await Promise.all(Object.values(this.dispatchers).map((d) => d?.close?.()))
  }

  private async deliverVisible(items: PushItem[]): Promise<void> {
    const verdicts = await withinBudget(
      items.map((item) => item.userId),
      VISIBLE_BUDGET,
      this.counters,
      this.logger,
    )
    const allowed = items.filter((_, i) => verdicts[i] === true)
    if (allowed.length === 0) return
    const tokens = await this.loadActiveTokens([...new Set(allowed.map((item) => item.userId))])
    const messagesByUser = new Map<string, PushMessage[]>()
    for (const { userId, payload } of allowed) {
      const messages = messagesByUser.get(userId) ?? []
      messages.push({ kind: "notification", payload })
      messagesByUser.set(userId, messages)
    }
    await this.dispatch(tokens, (userId) => messagesByUser.get(userId) ?? [])
  }

  private async dispatch(
    tokens: ActiveToken[],
    messagesFor: (userId: string) => PushMessage[],
  ): Promise<void> {
    if (tokens.length === 0) return
    // D7 stopped sending through Expo: a token still stored in its format is dead, so it goes.
    const expoTokens = tokens.filter((t) => isExpoPushToken(t.token)).map((t) => t.token)
    const deliveries: PlatformDeliveries = { ios: [], android: [], web: [] }
    const seen = new Set<string>()
    for (const t of tokens) {
      if (isExpoPushToken(t.token)) continue
      const key = `${t.platform}|${t.token}`
      if (seen.has(key)) continue
      seen.add(key)
      for (const message of messagesFor(t.userId)) {
        if (t.platform !== "web") deliveries[t.platform].push({ token: t.token, message })
        // Browsers require every push to show something, so clears go to phones only (D8).
        else if (message.kind === "notification") deliveries.web.push({ token: t.token, message })
      }
    }
    const dispatchers = this.getDispatchers()
    const invalid = (
      await Promise.all([
        this.dispatchPlatform("ios", dispatchers.ios, deliveries.ios),
        this.dispatchPlatform("android", dispatchers.android, deliveries.android),
        this.dispatchPlatform("web", dispatchers.web, deliveries.web),
      ])
    ).flat()
    const revoke = [...expoTokens, ...invalid]
    if (revoke.length > 0) await this.pruneTokens(revoke)
  }

  private async dispatchPlatform<M extends PushMessage>(
    platform: PushPlatform,
    dispatcher: PlatformDispatcher<M> | undefined,
    batch: PushDelivery<M>[],
  ): Promise<string[]> {
    if (batch.length === 0) return []
    if (!dispatcher) {
      this.logger.warn(
        { platform, count: batch.length },
        "push: platform has tokens but no configured credentials; skipping",
      )
      return []
    }
    try {
      return (await dispatcher(batch)).invalidTokens
    } catch (err) {
      this.logger.error({ err, platform }, "push: platform dispatch failed")
      return []
    }
  }

  private async loadActiveTokens(userIds: string[]): Promise<ActiveToken[]> {
    const rows = await this.db
      .select({
        userId: pushTokens.userId,
        platform: pushTokens.platform,
        token: pushTokens.token,
      })
      .from(pushTokens)
      .where(and(inArray(pushTokens.userId, userIds), isNull(pushTokens.revokedAt)))
      .orderBy(desc(pushTokens.createdAt))
      .limit(userIds.length * ACTIVE_TOKEN_SCAN_CAP_PER_USER)
    return rows.map((r) => ({ userId: r.userId, platform: r.platform, token: r.token }))
  }

  private async pruneTokens(tokens: string[]): Promise<void> {
    try {
      await this.db
        .update(pushTokens)
        .set({ revokedAt: new Date() })
        .where(and(inArray(pushTokens.token, tokens), isNull(pushTokens.revokedAt)))
    } catch (err) {
      this.logger.error({ err, count: tokens.length }, "push: failed to prune invalid tokens")
    }
  }

  private getDispatchers(): PushDispatchers {
    if (this.dispatchers) return this.dispatchers
    this.dispatchers = {
      ...(this.config.apns ? { ios: makeApnsDispatcher(this.config.apns, this.logger) } : {}),
      ...(this.config.fcm ? { android: makeFcmDispatcher(this.config.fcm, this.logger) } : {}),
      ...(this.config.webPush
        ? { web: makeWebPushDispatcher(this.config.webPush, this.logger) }
        : {}),
    }
    return this.dispatchers
  }
}

export { isSafePushEndpoint, resolveSafePushTarget } from "../services/push-token-policy.js"
