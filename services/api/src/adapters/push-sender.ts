/**
 * REAL PushSender adapter: APNs (node-apn) for iOS, FCM (firebase-admin) for Android, and Web Push
 * (web-push) for browsers. Token storage is in Postgres (push_tokens); this adapter is the READ side of
 * that store at send time.
 *
 * SEAM RULE: the vendor SDKs may ONLY be imported in the per-platform dispatcher modules (push-apns.ts /
 * push-fcm.ts / push-webpush.ts), via lazy dynamic import, so merely constructing this adapter (DI wiring)
 * loads no SDK and opens no connection; the first send() to a configured platform initializes that
 * platform's client once (memoized).
 *
 * DI selects FakePushSender when USE_FAKE_PUSH is set (the default in dev/test), so this real adapter is
 * only exercised when the flag is off AND creds are present. The token-selection + platform-routing logic
 * is unit-tested with the vendor dispatchers injected (so no real SDK call is made in tests).
 */

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
  /**
   * Expo push service config. The Expo dispatcher is ALWAYS active (the Expo push API works without an
   * access token, and the mobile app registers Expo tokens), so this only carries the optional access
   * token for enhanced push security.
   */
  expo?: ExpoPushConfig
}

/** A logger surface the adapter uses for skip/failure diagnostics. Defaults to console. */
export interface PushLogger {
  warn(obj: unknown, msg?: string): void
  error(obj: unknown, msg?: string): void
}

const consoleLogger: PushLogger = {
  warn: (obj, msg) => console.warn(msg ?? "", obj),
  error: (obj, msg) => console.error(msg ?? "", obj),
}

/** An active push token row as the send flow needs it. */
export interface ActiveToken {
  userId: string
  platform: PushPlatform
  token: string
}

/**
 * Per-platform dispatcher seam. Each delivers `payload` to the given tokens for ONE platform and returns
 * the tokens the provider reported as invalid/unregistered (to be pruned). A dispatcher is `undefined`
 * when that platform has no configured creds (so the send flow skips it). Injectable so the
 * routing/selection/pruning logic is unit-tested without the real SDKs. The optional `close()` tears down
 * any long-lived vendor connection on container shutdown.
 */
export interface PushDispatchers {
  ios?: PlatformDispatcher
  android?: PlatformDispatcher
  web?: PlatformDispatcher
  /** Cross-platform Expo push dispatcher (serves ios + android Expo tokens). */
  expo?: PlatformDispatcher
}

/** Deliver to one platform's tokens; resolve with the subset that were invalid/unregistered. */
export interface PlatformDispatcher {
  (tokens: string[], payload: PushPayload): Promise<{ invalidTokens: string[] }>
  close?(): Promise<void>
}

export interface PushSenderDeps {
  db: Db
  config: PushSenderConfig
  /** Injected dispatchers (tests). When omitted, lazily built from `config` + the vendor SDKs. */
  dispatchers?: PushDispatchers
  logger?: PushLogger
}

export class MultiPushSender implements PushSender {
  private readonly db: Db
  private readonly config: PushSenderConfig
  private readonly logger: PushLogger
  // Memoized dispatchers (built once on first send unless injected).
  private dispatchers: PushDispatchers | undefined

  constructor(deps: PushSenderDeps) {
    this.db = deps.db
    this.config = deps.config
    this.logger = deps.logger ?? consoleLogger
    if (deps.dispatchers) this.dispatchers = deps.dispatchers
  }

  /**
   * No-op: the canonical push_tokens row is persisted by the notification service before send time, and
   * APNs/FCM/Web Push need no provider-side pre-registration. Present to satisfy the PushSender contract.
   */
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

  /** Tear down any long-lived vendor connections (duck-typed by di.ts close()). */
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

    // Expo-managed tokens (what the mobile app registers, for BOTH ios + android) deliver through the Expo
    // push service regardless of platform; raw device tokens fall through to the per-platform APNs/FCM/Web
    // Push dispatchers below. Without this, the Expo tokens iOS/Android register can never be delivered.
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

    // Raw (non-Expo) device tokens route per platform to APNs / FCM / Web Push.
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
          // A provider/transport failure for one platform must not break the others or the request.
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

  /** Soft-revoke (revoked_at = now) the tokens a provider reported as invalid/unregistered. */
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

  /** Build (once) the per-platform dispatchers from config, or return the injected/memoized set. */
  private getDispatchers(): PushDispatchers {
    if (this.dispatchers) return this.dispatchers
    this.dispatchers = {
      ...(this.config.apns ? { ios: makeApnsDispatcher(this.config.apns, this.logger) } : {}),
      ...(this.config.fcm ? { android: makeFcmDispatcher(this.config.fcm, this.logger) } : {}),
      ...(this.config.webPush ? { web: makeWebPushDispatcher(this.config.webPush, this.logger) } : {}),
      // The Expo dispatcher is always built: the Expo push API needs no credentials (the access token is
      // optional) and the mobile app registers Expo tokens, so it must always be available to send them.
      expo: makeExpoDispatcher(this.config.expo ?? {}, this.logger),
    }
    return this.dispatchers
  }
}

/** Group active tokens by platform into deduplicated token-string lists. */
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

/**
 * SSRF guard for a Web Push endpoint. The endpoint is fully attacker-controlled (any authed user can
 * register one) and web-push POSTs to it server-side, so we must refuse anything that resolves to a
 * non-public host. Resolve-then-validate (DNS-rebind defense): require https:, then resolve the hostname
 * and reject if ANY resolved address is in the private/loopback/link-local/CGNAT/ULA deny set. Pure of
 * exceptions (any parse/resolve failure => unsafe).
 */
export async function isSafePushEndpoint(endpoint: string): Promise<boolean> {
  let host: string
  try {
    const u = new URL(endpoint)
    if (u.protocol !== "https:") return false
    host = u.hostname.toLowerCase()
    if (host.length === 0) return false
    host = host.replace(/^\[|\]$/g, "") // strip IPv6 brackets if URL kept them
    if (host === "localhost" || host.endsWith(".localhost")) return false
    if (host.endsWith(".internal") || host.endsWith(".local")) return false
  } catch {
    return false
  }

  // A bare IP literal: validate it directly (no DNS lookup).
  const litFam = isIP(host)
  if (litFam !== 0) return isPublicAddress(host)

  // A DNS name: resolve EVERY A/AAAA record and require all to be public (so a name that rebinds to a
  // private IP can't slip through).
  try {
    const addrs = await lookup(host, { all: true })
    if (addrs.length === 0) return false
    return addrs.every((a) => isPublicAddress(a.address))
  } catch {
    return false
  }
}

/** True only for a globally-routable IP literal (blocks loopback/RFC1918/link-local/CGNAT/ULA/reserved). */
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
  if (a === 0 || a === 127) return false // "this host" / loopback
  if (a === 10) return false // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return false // RFC1918
  if (a === 192 && b === 168) return false // RFC1918
  if (a === 169 && b === 254) return false // link-local incl. 169.254.169.254 metadata
  if (a === 100 && b >= 64 && b <= 127) return false // CGNAT 100.64/10
  if (a === 192 && b === 0 && o[2] === 0) return false // IETF protocol assignments 192.0.0/24
  if (a >= 224) return false // multicast 224/4 + reserved 240/4 + 255.255.255.255
  return true
}

function isPublicIpv6(addr: string): boolean {
  const h = addr.toLowerCase()
  if (h === "::" || h === "::1") return false // unspecified / loopback
  if (h.startsWith("fe8") || h.startsWith("fe9") || h.startsWith("fea") || h.startsWith("feb")) {
    return false // fe80::/10 link-local
  }
  if (h.startsWith("fc") || h.startsWith("fd")) return false // fc00::/7 ULA
  if (h.startsWith("ff")) return false // ff00::/8 multicast
  // IPv4-mapped (::ffff:a.b.c.d) — validate the embedded v4 against the v4 deny set.
  const mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped?.[1]) return isPublicIpv4(mapped[1])
  return true
}

/** Parse a persisted Web Push subscription JSON string; null when malformed or keys are the wrong shape. */
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
