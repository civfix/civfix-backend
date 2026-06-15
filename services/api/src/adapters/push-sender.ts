/**
 * REAL PushSender adapter: APNs (node-apn) for iOS, FCM (firebase-admin) for Android, and Web Push
 * (web-push) for browsers. Token storage is in Postgres (push_tokens); this adapter is the READ side of
 * that store at send time.
 *
 * SEAM RULE: node-apn / firebase-admin / web-push may ONLY be imported in THIS file. They are pulled in
 * via lazy dynamic import inside the per-platform dispatcher factories, so merely constructing this
 * adapter (DI wiring) loads no SDK and opens no connection; the first send() to a configured platform
 * initializes that platform's client once (memoized).
 *
 * DI selects FakePushSender when USE_FAKE_PUSH is set (the default in dev/test), so this real adapter is
 * only exercised when the flag is off AND creds are present. It is still implemented fully and correctly,
 * and the token-selection + platform-routing logic is unit-tested with the vendor dispatchers injected
 * (so no real SDK call is made in tests).
 *
 * SEND FLOW (send / sendMany):
 *   1. Load the recipients' ACTIVE push tokens (revoked_at IS NULL) from push_tokens.
 *   2. Group them by platform.
 *   3. Dispatch each platform's tokens through its vendor dispatcher. If a platform has NO configured
 *      creds, that platform is SKIPPED with a log (never throws) - the others still deliver.
 *   4. Each dispatcher returns the set of tokens the provider reported as invalid/unregistered; those are
 *      pruned (revoked_at = now) so we stop sending to dead devices.
 *
 * registerToken is a documented no-op here: the canonical push_tokens row is written by the notification
 * service (NotificationRepository.upsertPushToken) BEFORE this adapter is asked to send, and APNs/FCM/Web
 * Push are token-addressed at send time (no provider-side pre-registration step). Keeping registration in
 * the service (one DB write) avoids a split source of truth.
 */

import type { PushSender, PushPayload, PushPlatform } from "@civfix/shared/interfaces"
import type { Db } from "../db/client.js"
import { pushTokens } from "../db/schema/push_tokens.js"
import { and, inArray, isNull } from "drizzle-orm"
import { isIP } from "node:net"

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Token selection types
// ---------------------------------------------------------------------------

/** An active push token row as the send flow needs it. */
export interface ActiveToken {
  userId: string
  platform: PushPlatform
  token: string
}

/**
 * Per-platform dispatcher seam. Each method delivers `payload` to the given tokens for ONE platform and
 * returns the tokens the provider reported as invalid/unregistered (to be pruned). A dispatcher is
 * `undefined` when that platform has no configured creds (so the send flow skips it). Injectable so the
 * routing/selection/pruning logic is unit-tested without the real SDKs.
 */
export interface PushDispatchers {
  ios?: PlatformDispatcher
  android?: PlatformDispatcher
  web?: PlatformDispatcher
}

/** Deliver to one platform's tokens; resolve with the subset that were invalid/unregistered. */
export type PlatformDispatcher = (
  tokens: string[],
  payload: PushPayload,
) => Promise<{ invalidTokens: string[] }>

export interface PushSenderDeps {
  db: Db
  config: PushSenderConfig
  /** Injected dispatchers (tests). When omitted, lazily built from `config` + the vendor SDKs. */
  dispatchers?: PushDispatchers
  logger?: PushLogger
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class MultiPushSender implements PushSender {
  private readonly db: Db
  private readonly config: PushSenderConfig
  private readonly logger: PushLogger
  /** Memoized dispatchers (built once on first send unless injected). */
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

  /** Load active tokens for the recipients, route by platform, dispatch, and prune invalids. */
  private async deliver(userIds: string[], payload: PushPayload): Promise<void> {
    const tokens = await this.loadActiveTokens(userIds)
    if (tokens.length === 0) return

    const byPlatform = groupByPlatform(tokens)
    const dispatchers = this.getDispatchers()

    // Dispatch each platform that has tokens. A platform with tokens but no creds is skipped with a log.
    const platforms: PushPlatform[] = ["ios", "android", "web"]
    const invalidAll: string[] = []
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

  /** SELECT the active (non-revoked) tokens for the given users. */
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
    }
    return this.dispatchers
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (token grouping)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Vendor dispatcher factories (SDKs confined here, loaded lazily)
// ---------------------------------------------------------------------------

/**
 * APNs dispatcher (node-apn). Builds a token-auth Provider once (memoized) on first send. Maps the payload
 * to an apn.Notification (alert title/body, topic = bundleId, data merged into the payload). Tokens whose
 * response status is 410 (Unregistered) or 400 with BadDeviceToken are reported invalid for pruning.
 */
export function makeApnsDispatcher(
  apns: NonNullable<PushSenderConfig["apns"]>,
  logger: PushLogger,
): PlatformDispatcher {
  // Lazily-built provider + Notification ctor (so node-apn is imported only on first real send). The
  // node-apn types are loose here (any) because the SDK is dynamically imported; we narrow what we touch.
  let providerPromise: Promise<{
    provider: any
    Notification: any
  }> | null = null

  async function getProvider() {
    if (!providerPromise) {
      providerPromise = (async () => {
        const apn = await import("node-apn")
        const provider = new apn.Provider({
          token: { key: apns.privateKey, keyId: apns.keyId, teamId: apns.teamId },
          production: apns.production,
        })
        return { provider, Notification: apn.Notification }
      })()
    }
    return providerPromise
  }

  return async (tokens, payload) => {
    const { provider, Notification } = await getProvider()
    const note = new Notification()
    note.topic = apns.bundleId
    note.alert = {
      title: payload.title,
      ...(payload.body !== undefined ? { body: payload.body } : {}),
    }
    note.sound = "default"
    note.payload = {
      ...(payload.data ?? {}),
      ...(payload.link !== undefined ? { link: payload.link } : {}),
    }

    const invalidTokens: string[] = []
    try {
      const result = await provider.send(note, tokens)
      // result.failed carries per-token failures; 410 (Unregistered) / BadDeviceToken => prune.
      for (const failure of result.failed ?? []) {
        const status = String(failure.status ?? "")
        const reason = failure.response?.reason ?? ""
        if (status === "410" || reason === "Unregistered" || reason === "BadDeviceToken") {
          if (typeof failure.device === "string") invalidTokens.push(failure.device)
        } else {
          logger.warn({ status, reason, device: failure.device }, "push(apns): delivery failure")
        }
      }
    } catch (err) {
      logger.error({ err }, "push(apns): send threw")
    }
    return { invalidTokens }
  }
}

/**
 * FCM dispatcher (firebase-admin). Initializes a NAMED app once (memoized) from the service-account JSON so
 * it never clashes with any other firebase usage. Uses sendEachForMulticast and maps unregistered/invalid
 * token error codes to the prune set.
 */
export function makeFcmDispatcher(
  fcm: NonNullable<PushSenderConfig["fcm"]>,
  logger: PushLogger,
): PlatformDispatcher {
  // Loose type: firebase-admin/messaging is dynamically imported; we only call sendEachForMulticast.
  let messagingPromise: Promise<any> | null = null

  async function getMessaging() {
    if (!messagingPromise) {
      messagingPromise = (async () => {
        const admin = await import("firebase-admin/app")
        const messaging = await import("firebase-admin/messaging")
        const serviceAccount = JSON.parse(fcm.serviceAccountJson) as Record<string, unknown>
        // A dedicated, named app so this never collides with another firebase-admin initialization.
        const appName = "civfix-push"
        const existing = admin.getApps().find((a) => a.name === appName)
        const app =
          existing ??
          admin.initializeApp(
            {
              credential: admin.cert(serviceAccount as never),
              ...(fcm.projectId !== undefined ? { projectId: fcm.projectId } : {}),
            },
            appName,
          )
        return messaging.getMessaging(app)
      })()
    }
    return messagingPromise
  }

  /** FCM error codes that mean "this token is dead; stop sending to it". */
  const PRUNE_CODES = new Set([
    "messaging/registration-token-not-registered",
    "messaging/invalid-registration-token",
    "messaging/invalid-argument",
  ])

  return async (tokens, payload) => {
    const messaging = await getMessaging()
    const message = {
      tokens,
      notification: {
        title: payload.title,
        ...(payload.body !== undefined ? { body: payload.body } : {}),
      },
      data: stringifyData({
        ...(payload.data ?? {}),
        ...(payload.link !== undefined ? { link: payload.link } : {}),
      }),
    }

    const invalidTokens: string[] = []
    try {
      const resp = await messaging.sendEachForMulticast(message)
      // responses[] aligns 1:1 with tokens[]; map failed indices with a prune-worthy code to their token.
      resp.responses.forEach((r: { success: boolean; error?: { code?: string } }, i: number) => {
        if (r.success) return
        const code: string = r.error?.code ?? ""
        if (PRUNE_CODES.has(code)) {
          const tok = tokens[i]
          if (tok !== undefined) invalidTokens.push(tok)
        } else {
          logger.warn({ code, token: tokens[i] }, "push(fcm): delivery failure")
        }
      })
    } catch (err) {
      logger.error({ err }, "push(fcm): send threw")
    }
    return { invalidTokens }
  }
}

/**
 * Web Push dispatcher (web-push). Sets VAPID details once (memoized). Each token is a JSON-encoded
 * PushSubscription string (what the browser's pushManager.subscribe() yields, persisted as the token). A
 * 404/410 from the push service means the subscription is gone => prune.
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
    await Promise.all(
      tokens.map(async (token) => {
        const subscription = parseSubscription(token)
        if (subscription === null) {
          // A token that is not a valid subscription JSON is useless; prune it.
          invalidTokens.push(token)
          return
        }
        // SECURITY (SSRF): the endpoint is attacker-controlled (any authed user registers it) and
        // web-push does a server-side POST to it. Refuse + prune endpoints that point at internal,
        // loopback, link-local (incl. 169.254.169.254 cloud metadata) or otherwise non-public hosts so
        // the API host cannot be used to probe/forge requests against the internal network.
        if (!isSafePushEndpoint(subscription.endpoint)) {
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
      }),
    )
    return { invalidTokens }
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Coerce a data bag to the all-string map FCM requires (non-strings are JSON-encoded). */
function stringifyData(data: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(data)) {
    out[k] = typeof v === "string" ? v : JSON.stringify(v)
  }
  return out
}

/**
 * SSRF guard for a Web Push endpoint. The endpoint is fully attacker-controlled (any authed user can
 * register one) and web-push POSTs to it server-side, so we must refuse anything that is not a public
 * host. Deny-by-IP-range (vs an allowlist) keeps legitimate FCM/APNs/Mozilla/WNS endpoints — which are
 * all public DNS names — working, while blocking internal/loopback/link-local/metadata targets. Pure,
 * dependency-free, and never throws (any parse failure => unsafe). NOTE: this does not defend against
 * DNS-rebinding (a public name that resolves to a private IP); that would require vetting the resolved
 * address at connect time and is out of scope for this minimal fix.
 */
export function isSafePushEndpoint(endpoint: string): boolean {
  try {
    const u = new URL(endpoint)
    if (u.protocol !== "https:") return false
    let host = u.hostname.toLowerCase()
    if (host.length === 0) return false
    // Strip IPv6 brackets if URL kept them.
    host = host.replace(/^\[|\]$/g, "")
    if (host === "localhost" || host.endsWith(".localhost")) return false

    const fam = isIP(host)
    if (fam === 0) {
      // A DNS name (the normal case for real push services). Block obvious internal suffixes; otherwise
      // allow (DNS-rebind is out of scope — see doc comment).
      if (host.endsWith(".internal") || host.endsWith(".local")) return false
      return true
    }
    if (fam === 4) return isPublicIpv4(host)
    // IPv6 literal: real push services never use bare IPv6 literals. Reject all to avoid the complexity
    // of enumerating ULA/link-local/IPv4-mapped ranges.
    return false
  } catch {
    return false
  }
}

/** True only for a globally-routable IPv4 literal (blocks RFC1918/loopback/link-local/CGNAT/reserved). */
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

/** Parse a persisted Web Push subscription JSON string; null when malformed. */
function parseSubscription(token: string): { endpoint: string; keys: unknown } | null {
  try {
    const parsed = JSON.parse(token) as { endpoint?: unknown; keys?: unknown }
    if (typeof parsed.endpoint === "string" && parsed.keys !== undefined) {
      return { endpoint: parsed.endpoint, keys: parsed.keys }
    }
    return null
  } catch {
    return null
  }
}
