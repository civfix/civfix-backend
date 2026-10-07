import { isIP } from "node:net"
import { lookup, Resolver } from "node:dns/promises"
import type { PushPlatform } from "@civfix/shared/interfaces"
import { isExpoPushToken } from "../adapters/push-expo.js"
import { expandIpv6Hextets } from "../adapters/net-ipv6.js"

export const PUSH_DNS_TIMEOUT_MS = 2_000
export const PUSH_DNS_TRIES = 1

const IPV6_BRACKETS_RE = /^\[|\]$/g
const LOCALHOST = "localhost"
const NON_PUBLIC_HOST_SUFFIXES = [".localhost", ".internal", ".local"] as const
const IPV4_OCTET_MAX = 255
const IPV6_HEXTET_RE = /^[0-9a-f]{1,4}$/

export type PushAddressResolver = (host: string) => Promise<string[]>

export const lookupAddresses: PushAddressResolver = async (host) => {
  const addrs = await lookup(host, { all: true })
  return addrs.map((a) => a.address)
}

export function makeBoundedAddressResolver(
  opts: { timeoutMs?: number; tries?: number } = {},
): PushAddressResolver {
  const resolver = new Resolver({
    timeout: opts.timeoutMs ?? PUSH_DNS_TIMEOUT_MS,
    tries: opts.tries ?? PUSH_DNS_TRIES,
  })
  return async (host) => {
    // A host with no record of one family answers that lookup with an error (ENODATA), which is
    // normal; if both come back empty the caller refuses the endpoint.
    const [v4, v6] = await Promise.all([
      resolver.resolve4(host).catch(() => [] as string[]),
      resolver.resolve6(host).catch(() => [] as string[]),
    ])
    return [...v4, ...v6]
  }
}

export const boundedAddressResolver = makeBoundedAddressResolver()

export async function isRegistrablePushEndpoint(
  endpoint: string,
  resolve: PushAddressResolver = boundedAddressResolver,
): Promise<boolean> {
  return (await resolveSafePushTarget(endpoint, resolve)) !== null
}

export async function isSafePushEndpoint(endpoint: string): Promise<boolean> {
  return (await resolveSafePushTarget(endpoint)) !== null
}

export async function resolveSafePushTarget(
  endpoint: string,
  resolve: PushAddressResolver = boundedAddressResolver,
): Promise<{ host: string; address: string; family: 4 | 6 } | null> {
  let host: string
  try {
    const u = new URL(endpoint)
    if (u.protocol !== "https:") return null
    host = u.hostname.toLowerCase()
    if (host.length === 0) return null
    host = host.replace(IPV6_BRACKETS_RE, "")
    if (host === LOCALHOST || NON_PUBLIC_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
      return null
    }
  } catch {
    return null
  }

  const litFam = isIP(host)
  if (litFam !== 0) {
    if (!isPublicAddress(host)) return null
    return { host, address: host, family: litFam as 4 | 6 }
  }

  let addresses: string[]
  try {
    addresses = await resolve(host)
  } catch {
    // Fail closed: an endpoint whose addresses cannot be checked is never contacted.
    return null
  }
  if (addresses.length === 0) return null
  if (!addresses.every((address) => isPublicAddress(address))) return null
  const first = addresses[0]
  if (first === undefined) return null
  const family = isIP(first)
  if (family !== 4 && family !== 6) return null
  return { host, address: first, family }
}

function isPublicAddress(addr: string): boolean {
  const fam = isIP(addr)
  if (fam === 4) return isPublicIpv4(addr)
  if (fam === 6) return isPublicIpv6(addr)
  return false
}

function isOctet(n: number): boolean {
  return Number.isInteger(n) && n >= 0 && n <= IPV4_OCTET_MAX
}

function isPublicIpv4(host: string): boolean {
  const parts = host.split(".")
  if (parts.length !== 4) return false
  const o = parts.map((p) => Number(p))
  if (!o.every(isOctet)) return false
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
    if (!nums.every(isOctet)) return null
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
    if (!IPV6_HEXTET_RE.test(g)) return null
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
  if (
    b[0] === 0 &&
    b[1] === 0x64 &&
    b[2] === 0xff &&
    b[3] === 0x9b &&
    b.slice(4, 12).every((x) => x === 0)
  ) {
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
const EXPO_PUSH_TOKEN_MAX_LENGTH = 512

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

function invalidToken(reason: string): PushTokenShape {
  return { ok: false, field: "token", reason }
}

function classifyWebSubscription(token: string): PushTokenShape {
  const subscription = parseSubscription(token)
  if (subscription === null) {
    return invalidToken(
      "web push tokens must be the subscription JSON: {endpoint, keys:{p256dh, auth}}",
    )
  }
  let url: URL
  try {
    url = new URL(subscription.endpoint)
  } catch {
    return invalidToken("subscription endpoint is not a URL")
  }
  if (url.protocol !== "https:") return invalidToken("subscription endpoint must be https")
  if (decodedByteLength(subscription.keys.p256dh) !== WEB_PUSH_P256DH_BYTES) {
    return invalidToken(`keys.p256dh must be ${WEB_PUSH_P256DH_BYTES} base64url-encoded bytes`)
  }
  if (decodedByteLength(subscription.keys.auth) !== WEB_PUSH_AUTH_BYTES) {
    return invalidToken(`keys.auth must be ${WEB_PUSH_AUTH_BYTES} base64url-encoded bytes`)
  }
  return { ok: true, kind: "web", endpoint: subscription.endpoint }
}

export function classifyPushToken(platform: PushPlatform, token: string): PushTokenShape {
  if (isExpoPushToken(token)) {
    return token.endsWith("]") && token.length <= EXPO_PUSH_TOKEN_MAX_LENGTH
      ? { ok: true, kind: "expo" }
      : invalidToken("malformed Expo push token")
  }
  if (platform === "web") return classifyWebSubscription(token)
  if (platform === "ios") {
    return APNS_TOKEN_RE.test(token) && token.length % 2 === 0
      ? { ok: true, kind: "apns" }
      : invalidToken("APNs device tokens are hex (64-200 characters)")
  }
  return FCM_TOKEN_RE.test(token)
    ? { ok: true, kind: "fcm" }
    : invalidToken("not a recognizable FCM registration token")
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
