
import type { PushSender, PushPayload, PushPlatform } from "@civfix/shared/interfaces"
import type { Db } from "../db/client.js"
import { pushTokens } from "../db/schema/push_tokens.js"
import { and, inArray, isNull } from "drizzle-orm"
import { isIP } from "node:net"
import { lookup } from "node:dns/promises"
import { makeApnsDispatcher } from "./push-apns.js"
import { makeFcmDispatcher } from "./push-fcm.js"
import { makeWebPushDispatcher } from "./push-webpush.js"
import { makeExpoDispatcher, isExpoPushToken, type ExpoPushConfig } from "./push-expo.js"

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
  }
  expo?: ExpoPushConfig
}

export interface PushLogger {
  warn(obj: unknown, msg?: string): void
  error(obj: unknown, msg?: string): void
}

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
}

export class MultiPushSender implements PushSender {
  private readonly db: Db
  private readonly config: PushSenderConfig
  private readonly logger: PushLogger
  private dispatchers: PushDispatchers | undefined

  constructor(deps: PushSenderDeps) {
    this.db = deps.db
    this.config = deps.config
    this.logger = deps.logger ?? consoleLogger
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

  private async deliver(userIds: string[], payload: PushPayload): Promise<void> {
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
  const halves = s.split("::")
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(":") : []
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : null
  let groups: string[]
  if (tail === null) {
    groups = head
  } else {
    const fill = 8 - head.length - tail.length
    if (fill < 1) return null
    groups = [...head, ...Array<string>(fill).fill("0"), ...tail]
  }
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
