import type { PushSender, PushPayload, PushPlatform } from "@civfix/shared/interfaces"
import type { Db } from "../db/client.js"
import { pushTokens } from "../db/schema/push_tokens.js"
import { and, desc, inArray, isNull } from "drizzle-orm"
import { makeApnsDispatcher } from "./push-apns.js"
import { makeFcmDispatcher } from "./push-fcm.js"
import { makeWebPushDispatcher } from "./push-webpush.js"
import { makeExpoDispatcher, isExpoPushToken, type ExpoPushConfig } from "./push-expo.js"
import { mapWithLimit } from "../lib/concurrency.js"
import { sha256HexSync } from "../lib/hash.js"
import type { CounterStore } from "../abuse/counter-store.js"
import type { PushAddressResolver } from "../services/push-token-policy.js"

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
  expo?: ExpoPushConfig
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

const NATIVE_PLATFORMS: readonly PushPlatform[] = ["ios", "android", "web"]

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

export interface PushDispatchers {
  ios?: PlatformDispatcher
  android?: PlatformDispatcher
  web?: PlatformDispatcher
  expo?: PlatformDispatcher
}

export interface PlatformDispatcher {
  (tokens: string[], payload: PushPayload): Promise<{ invalidTokens: string[] }>
  close?(): Promise<void>
}

export interface PushSenderDeps {
  db: Db
  config: PushSenderConfig
  dispatchers?: PushDispatchers
  logger?: PushLogger
  counters?: CounterStore
}

export const PUSH_MAX_PER_USER_PER_MINUTE = 60

const PUSH_RATE_WINDOW_SECONDS = 60
const PUSH_RATE_CHECK_CONCURRENCY = 16
const PUSH_RATE_KEY_PREFIX = "push:rate:"

export async function allowedByPushRate(
  userIds: string[],
  counters: CounterStore | undefined,
  logger: PushLogger,
): Promise<string[]> {
  if (!counters || userIds.length === 0) return userIds
  const verdicts = await mapWithLimit(
    userIds,
    PUSH_RATE_CHECK_CONCURRENCY,
    async (userId): Promise<boolean> => {
      try {
        const used = await counters.incr(
          `${PUSH_RATE_KEY_PREFIX}${userId}`,
          PUSH_RATE_WINDOW_SECONDS,
        )
        return used <= PUSH_MAX_PER_USER_PER_MINUTE
      } catch (err) {
        logger.warn({ err }, "push: per-user rate counter unavailable; allowing")
        return true
      }
    },
  )
  const allowed = userIds.filter((_, i) => verdicts[i] === true)
  if (allowed.length < userIds.length) {
    logger.warn(
      { dropped: userIds.length - allowed.length, capPerMinute: PUSH_MAX_PER_USER_PER_MINUTE },
      "push: per-user rate cap reached; dropping excess device pushes",
    )
  }
  return allowed
}

export class MultiPushSender implements PushSender {
  private readonly db: Db
  private readonly config: PushSenderConfig
  private readonly logger: PushLogger
  private readonly counters: CounterStore | undefined
  private dispatchers: PushDispatchers | undefined

  constructor(deps: PushSenderDeps) {
    this.db = deps.db
    this.config = deps.config
    this.logger = deps.logger ?? consoleLogger
    this.counters = deps.counters
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
    return this.deliver([userId], payload)
  }

  sendMany(userIds: string[], payload: PushPayload): Promise<void> {
    if (userIds.length === 0) return Promise.resolve()
    return this.deliver(userIds, payload)
  }

  async close(): Promise<void> {
    if (!this.dispatchers) return
    await Promise.all(Object.values(this.dispatchers).map((d) => d?.close?.()))
  }

  private async deliver(recipientIds: string[], payload: PushPayload): Promise<void> {
    const userIds = await allowedByPushRate(recipientIds, this.counters, this.logger)
    if (userIds.length === 0) return
    const tokens = await this.loadActiveTokens(userIds)
    if (tokens.length === 0) return

    const dispatchers = this.getDispatchers()
    const expoInvalid = await this.dispatchExpo(dispatchers.expo, tokens, payload)
    const nativeInvalid = await this.dispatchNative(dispatchers, tokens, payload)
    const invalidAll = [...expoInvalid, ...nativeInvalid]
    if (invalidAll.length > 0) await this.pruneTokens(invalidAll)
  }

  private async dispatchExpo(
    expo: PlatformDispatcher | undefined,
    tokens: ActiveToken[],
    payload: PushPayload,
  ): Promise<string[]> {
    const expoTokens = [
      ...new Set(tokens.filter((t) => isExpoPushToken(t.token)).map((t) => t.token)),
    ]
    if (expoTokens.length === 0) return []
    if (!expo) {
      this.logger.warn(
        { count: expoTokens.length },
        "push: expo tokens present but no expo dispatcher; skipping",
      )
      return []
    }
    try {
      const { invalidTokens } = await expo(expoTokens, payload)
      return invalidTokens
    } catch (err) {
      this.logger.error({ err }, "push: expo dispatch failed")
      return []
    }
  }

  private async dispatchNative(
    dispatchers: PushDispatchers,
    tokens: ActiveToken[],
    payload: PushPayload,
  ): Promise<string[]> {
    const byPlatform = groupByPlatform(tokens.filter((t) => !isExpoPushToken(t.token)))
    const invalid: string[] = []
    await Promise.all(
      NATIVE_PLATFORMS.map(async (platform) => {
        const platformTokens = byPlatform[platform]
        if (!platformTokens || platformTokens.length === 0) return
        const dispatcher = dispatchers[platform]
        if (!dispatcher) {
          this.logger.warn(
            { platform, count: platformTokens.length },
            "push: platform has tokens but no configured credentials; skipping",
          )
          return
        }
        try {
          const { invalidTokens } = await dispatcher(platformTokens, payload)
          invalid.push(...invalidTokens)
        } catch (err) {
          this.logger.error({ err, platform }, "push: platform dispatch failed")
        }
      }),
    )
    return invalid
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
      expo: makeExpoDispatcher(this.config.expo ?? {}, this.logger),
    }
    return this.dispatchers
  }
}

export function groupByPlatform(tokens: ActiveToken[]): Record<PushPlatform, string[]> {
  const out: Record<PushPlatform, string[]> = { ios: [], android: [], web: [] }
  const seen: Record<PushPlatform, Set<string>> = {
    ios: new Set(),
    android: new Set(),
    web: new Set(),
  }
  for (const t of tokens) {
    if (seen[t.platform].has(t.token)) continue
    seen[t.platform].add(t.token)
    out[t.platform].push(t.token)
  }
  return out
}

export { isSafePushEndpoint, resolveSafePushTarget } from "../services/push-token-policy.js"
