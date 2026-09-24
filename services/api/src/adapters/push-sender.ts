import { createHash } from "node:crypto"
import type { PushSender, PushPayload, PushPlatform } from "@civfix/shared/interfaces"
import type { Db } from "../db/client.js"
import { pushTokens } from "../db/schema/push_tokens.js"
import { and, desc, inArray, isNull } from "drizzle-orm"
import { makeApnsDispatcher } from "./push-apns.js"
import { makeFcmDispatcher } from "./push-fcm.js"
import { makeWebPushDispatcher } from "./push-webpush.js"
import { makeExpoDispatcher, isExpoPushToken, type ExpoPushConfig } from "./push-expo.js"
import { mapWithLimit } from "../services/media-presign.js"
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

export function hashForLog(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12)
}

const ACTIVE_TOKEN_SCAN_CAP_PER_USER = 20

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
        const used = await counters.incr(`push:rate:${userId}`, PUSH_RATE_WINDOW_SECONDS)
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
    const invalidAll: string[] = []

    const expoTokens = [
      ...new Set(tokens.filter((t) => isExpoPushToken(t.token)).map((t) => t.token)),
    ]
    if (expoTokens.length > 0) {
      const expo = dispatchers.expo
      if (expo) {
        try {
          const { invalidTokens } = await expo(expoTokens, payload)
          for (const t of invalidTokens) invalidAll.push(t)
        } catch (err) {
          this.logger.error({ err }, "push: expo dispatch failed")
        }
      } else {
        this.logger.warn(
          { count: expoTokens.length },
          "push: expo tokens present but no expo dispatcher; skipping",
        )
      }
    }

    const rawTokens = tokens.filter((t) => !isExpoPushToken(t.token))
    const byPlatform = groupByPlatform(rawTokens)
    const platforms: PushPlatform[] = ["ios", "android", "web"]
    await Promise.all(
      platforms.map(async (platform) => {
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
          for (const t of invalidTokens) invalidAll.push(t)
        } catch (err) {
          this.logger.error({ err, platform }, "push: platform dispatch failed")
        }
      }),
    )

    if (invalidAll.length > 0) await this.pruneTokens(invalidAll)
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

export { makeApnsDispatcher } from "./push-apns.js"
export { makeFcmDispatcher } from "./push-fcm.js"
export { makeWebPushDispatcher } from "./push-webpush.js"

export {
  boundedAddressResolver,
  classifyPushToken,
  isRegistrablePushEndpoint,
  isSafePushEndpoint,
  parseSubscription,
  resolveSafePushTarget,
  type PushTokenShape,
} from "../services/push-token-policy.js"
