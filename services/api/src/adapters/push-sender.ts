
import { createHash } from "node:crypto"
import type { PushSender, PushPayload, PushPlatform } from "@civfix/shared/interfaces"
import type { Db } from "../db/client.js"
import { pushTokens } from "../db/schema/push_tokens.js"
import { and, desc, inArray, isNull } from "drizzle-orm"
import { isIP } from "node:net"
import { lookup } from "node:dns/promises"
import { makeApnsDispatcher } from "./push-apns.js"
import { makeFcmDispatcher } from "./push-fcm.js"
import { makeWebPushDispatcher } from "./push-webpush.js"
import { makeExpoDispatcher, isExpoPushToken, type ExpoPushConfig } from "./push-expo.js"
import { expandIpv6Hextets } from "./net-ipv6.js"
import { mapWithLimit } from "../services/media-presign.js"
import type { CounterStore } from "../abuse/counter-store.js"

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
    await Promise.all(
      Object.values(this.dispatchers).map((d) => d?.close?.()),
    )
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
      ...(this.config.webPush ? { web: makeWebPushDispatcher(this.config.webPush, this.logger) } : {}),
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

export async function isSafePushEndpoint(endpoint: string): Promise<boolean> {
  return (await resolveSafePushTarget(endpoint)) !== null
}

export async function resolveSafePushTarget(
  endpoint: string,
): Promise<{ host: string; address: string; family: 4 | 6 } | null> {
  let host: string
  try {
    const u = new URL(endpoint)
    if (u.protocol !== "https:") return null
    host = u.hostname.toLowerCase()
    if (host.length === 0) return null
    host = host.replace(/^\[|\]$/g, "")
    if (host === "localhost" || host.endsWith(".localhost")) return null
    if (host.endsWith(".internal") || host.endsWith(".local")) return null
  } catch {
    return null
  }

  const litFam = isIP(host)
  if (litFam !== 0) {
    if (!isPublicAddress(host)) return null
    return { host, address: host, family: litFam as 4 | 6 }
  }

  try {
    const addrs = await lookup(host, { all: true })
    if (addrs.length === 0) return null
    if (!addrs.every((a) => isPublicAddress(a.address))) return null
    const first = addrs[0]
    if (!first) return null
    return { host, address: first.address, family: first.family as 4 | 6 }
  } catch {
    return null
  }
}

function isPublicAddress(addr: string): boolean {
  const fam = isIP(addr)
  if (fam === 4) return isPublicIpv4(addr)
  if (fam === 6) return isPublicIpv6(addr)
  return false
}

function isPublicIpv4(host: string): boolean {
  const parts = host.split(".")
  if (parts.length !== 4) return false
  const o = parts.map((p) => Number(p))
  if (o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false
  const [a, b] = o as [number, number, number, number]
  if (a === 0 || a === 127) return false
  if (a === 10) return false
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && b === 168) return false
  if (a === 169 && b === 254) return false
  if (a === 100 && b >= 64 && b <= 127) return false
  if (a === 192 && b === 0 && o[2] === 0) return false
  if (a >= 224) return false
  return true
}

function ipv6ToBytes(input: string): number[] | null {
  let s = input.toLowerCase().split("%")[0] ?? ""
  if (s.includes(".")) {
    const cut = s.lastIndexOf(":")
    if (cut < 0) return null
    const quad = s.slice(cut + 1).split(".")
    if (quad.length !== 4) return null
    const nums = quad.map((p) => Number(p))
    if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null
    const hi = ((nums[0]! << 8) | nums[1]!).toString(16)
    const lo = ((nums[2]! << 8) | nums[3]!).toString(16)
    s = `${s.slice(0, cut + 1)}${hi}:${lo}`
  }
  const { hextets: groups, runs, fill } = expandIpv6Hextets(s)
  if (runs > 1) return null
  if (runs === 1 && fill < 1) return null
  if (groups.length !== 8) return null
  const bytes: number[] = []
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null
    const v = parseInt(g, 16)
    bytes.push((v >> 8) & 0xff, v & 0xff)
  }
  return bytes
}

function isPublicIpv6(addr: string): boolean {
  const b = ipv6ToBytes(addr)
  if (!b) return false
  if (b.every((x) => x === 0)) return false
  const embeddedV4 = () => b.slice(12).join(".")
  const first10Zero = b.slice(0, 10).every((x) => x === 0)
  if (first10Zero && b[10] === 0xff && b[11] === 0xff) return isPublicIpv4(embeddedV4())
  if (first10Zero && b[10] === 0 && b[11] === 0) return isPublicIpv4(embeddedV4())
  if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b.slice(4, 12).every((x) => x === 0)) {
    return isPublicIpv4(embeddedV4())
  }
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return false
  if ((b[0]! & 0xfe) === 0xfc) return false
  if (b[0] === 0xff) return false
  return true
}

const WEB_PUSH_P256DH_BYTES = 65
const WEB_PUSH_AUTH_BYTES = 16
const BASE64URL_RE = /^[A-Za-z0-9_-]+={0,2}$/
const APNS_TOKEN_RE = /^[0-9a-fA-F]{64,200}$/
const FCM_TOKEN_RE = /^[A-Za-z0-9_:.~%+-]{64,2048}$/

function decodedByteLength(value: string): number | null {
  if (!BASE64URL_RE.test(value)) return null
  try {
    return Buffer.from(value, "base64url").length
  } catch {
    return null
  }
}

export type PushTokenShape =
  | { ok: true; kind: "expo" }
  | { ok: true; kind: "apns" }
  | { ok: true; kind: "fcm" }
  | { ok: true; kind: "web"; endpoint: string }
  | { ok: false; field: string; reason: string }

export function classifyPushToken(platform: PushPlatform, token: string): PushTokenShape {
  if (isExpoPushToken(token)) {
    return token.endsWith("]") && token.length <= 512
      ? { ok: true, kind: "expo" }
      : { ok: false, field: "token", reason: "malformed Expo push token" }
  }
  if (platform === "web") {
    const subscription = parseSubscription(token)
    if (subscription === null) {
      return {
        ok: false,
        field: "token",
        reason: "web push tokens must be the subscription JSON: {endpoint, keys:{p256dh, auth}}",
      }
    }
    let url: URL
    try {
      url = new URL(subscription.endpoint)
    } catch {
      return { ok: false, field: "token", reason: "subscription endpoint is not a URL" }
    }
    if (url.protocol !== "https:") {
      return { ok: false, field: "token", reason: "subscription endpoint must be https" }
    }
    if (decodedByteLength(subscription.keys.p256dh) !== WEB_PUSH_P256DH_BYTES) {
      return {
        ok: false,
        field: "token",
        reason: `keys.p256dh must be ${WEB_PUSH_P256DH_BYTES} base64url-encoded bytes`,
      }
    }
    if (decodedByteLength(subscription.keys.auth) !== WEB_PUSH_AUTH_BYTES) {
      return {
        ok: false,
        field: "token",
        reason: `keys.auth must be ${WEB_PUSH_AUTH_BYTES} base64url-encoded bytes`,
      }
    }
    return { ok: true, kind: "web", endpoint: subscription.endpoint }
  }
  if (platform === "ios") {
    return APNS_TOKEN_RE.test(token) && token.length % 2 === 0
      ? { ok: true, kind: "apns" }
      : { ok: false, field: "token", reason: "APNs device tokens are hex (64-200 characters)" }
  }
  return FCM_TOKEN_RE.test(token)
    ? { ok: true, kind: "fcm" }
    : { ok: false, field: "token", reason: "not a recognizable FCM registration token" }
}

export function parseSubscription(
  token: string,
): { endpoint: string; keys: { p256dh: string; auth: string } } | null {
  try {
    const parsed = JSON.parse(token) as { endpoint?: unknown; keys?: unknown }
    if (typeof parsed.endpoint !== "string") return null
    const keys = parsed.keys
    if (keys === null || typeof keys !== "object") return null
    const { p256dh, auth } = keys as { p256dh?: unknown; auth?: unknown }
    if (typeof p256dh !== "string" || typeof auth !== "string") return null
    return { endpoint: parsed.endpoint, keys: { p256dh, auth } }
  } catch {
    return null
  }
}
