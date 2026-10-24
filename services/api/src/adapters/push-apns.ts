import { connect, constants, type ClientHttp2Session } from "node:http2"
import { createPrivateKey, sign, type KeyObject } from "node:crypto"
import type { PushPayload } from "@civfix/seams"
import type { PushSenderConfig, PushLogger, PlatformDispatcher } from "./push-sender.js"
import { hashForLog } from "./push-sender.js"

const APNS_GONE_STATUS = "410"

const APNS_PRUNE_REASONS: ReadonlySet<string> = new Set(["Unregistered", "BadDeviceToken"])

const APNS_SOUND = "default"

const APNS_PRODUCTION_ORIGIN = "https://api.push.apple.com:443"
const APNS_SANDBOX_ORIGIN = "https://api.sandbox.push.apple.com:443"

const MAX_CONCURRENT_REQUESTS = 32

// Apple rejects a provider token older than an hour and answers TooManyProviderTokenUpdates when one is
// replaced more often than every 20 minutes, so even an ExpiredProviderToken can't rebuild a younger one.
const PROVIDER_TOKEN_TTL_MS = 50 * 60_000
const PROVIDER_TOKEN_MIN_AGE_MS = 20 * 60_000

// APNs answers in milliseconds; a request this long without an answer means the connection is dead,
// which TCP alone takes many minutes to notice.
const REQUEST_TIMEOUT_MS = 10_000

const EXPIRED_PROVIDER_TOKEN = "ExpiredProviderToken"

export function isApnsPruneFailure(status: string, reason: string): boolean {
  return status === APNS_GONE_STATUS || APNS_PRUNE_REASONS.has(reason)
}

type Outcome =
  | { kind: "answered"; status: string; reason: string }
  | { kind: "unprocessed" }
  | { kind: "failed"; err: unknown }

interface Connection {
  session: ClientHttp2Session
  inFlight: number
}

interface ProviderToken {
  jwt: string
  issuedAtMs: number
}

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url")
}

function alertBody(payload: PushPayload): string {
  return JSON.stringify({
    ...(payload.data ?? {}),
    ...(payload.link !== undefined ? { link: payload.link } : {}),
    aps: {
      alert: {
        title: payload.title,
        ...(payload.body !== undefined ? { body: payload.body } : {}),
      },
      sound: APNS_SOUND,
    },
  })
}

function reasonOf(body: string): string {
  if (body === "") return ""
  try {
    const parsed: unknown = JSON.parse(body)
    const reason = (parsed as { reason?: unknown } | null)?.reason
    return typeof reason === "string" ? reason : ""
  } catch {
    return ""
  }
}

export function makeApnsDispatcher(
  apns: NonNullable<PushSenderConfig["apns"]>,
  logger: PushLogger,
): PlatformDispatcher {
  const origin = apns.production ? APNS_PRODUCTION_ORIGIN : APNS_SANDBOX_ORIGIN
  let signingKey: KeyObject | null = null
  let providerToken: ProviderToken | null = null
  let connection: Connection | null = null
  let active = 0
  const waiting: (() => void)[] = []

  function buildProviderToken(nowMs: number): ProviderToken {
    signingKey ??= createPrivateKey(apns.privateKey)
    const input = `${base64urlJson({ alg: "ES256", kid: apns.keyId })}.${base64urlJson({
      iss: apns.teamId,
      iat: Math.floor(nowMs / 1000),
    })}`
    // JWS wants the raw r||s signature, not node's default DER encoding.
    const signature = sign("sha256", Buffer.from(input), {
      key: signingKey,
      dsaEncoding: "ieee-p1363",
    })
    return { jwt: `${input}.${signature.toString("base64url")}`, issuedAtMs: nowMs }
  }

  function currentJwt(): string {
    const now = Date.now()
    if (!providerToken || now - providerToken.issuedAtMs >= PROVIDER_TOKEN_TTL_MS) {
      providerToken = buildProviderToken(now)
    }
    return providerToken.jwt
  }

  // Concurrent requests rejected with the same token rebuild it once: the first one through replaces it,
  // the rest find it already replaced and resend with the new one.
  function refreshAfterExpired(rejectedJwt: string): boolean {
    if (!providerToken) return false
    if (providerToken.jwt !== rejectedJwt) return true
    const now = Date.now()
    if (now - providerToken.issuedAtMs < PROVIDER_TOKEN_MIN_AGE_MS) return false
    providerToken = buildProviderToken(now)
    return true
  }

  function openConnection(): Connection {
    if (connection && !connection.session.closed && !connection.session.destroyed) {
      return connection
    }
    const opened: Connection = { session: connect(origin), inFlight: 0 }
    const forget = () => {
      if (connection === opened) connection = null
    }
    opened.session.on("goaway", () => {
      forget()
      // Node keeps the socket of a session that got a GOAWAY open until the peer closes it; with none of
      // our requests left on it there is nothing to wait for.
      if (opened.inFlight === 0) opened.session.destroy()
    })
    opened.session.on("close", forget)
    opened.session.on("error", (err) => logger.warn({ err }, "push(apns): session error"))
    connection = opened
    return opened
  }

  async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (active < MAX_CONCURRENT_REQUESTS) active++
    else await new Promise<void>((resolve) => waiting.push(resolve))
    try {
      return await fn()
    } finally {
      const next = waiting.shift()
      if (next) next()
      else active--
    }
  }

  function post(token: string, body: string, jwt: string): Promise<Outcome> {
    return new Promise((resolve) => {
      const conn = openConnection()
      const stream = conn.session.request({
        ":method": "POST",
        ":path": `/3/device/${encodeURIComponent(token)}`,
        "apns-topic": apns.bundleId,
        authorization: `bearer ${jwt}`,
      })
      conn.inFlight++
      let status = ""
      let response = ""
      let failure: unknown
      const deadline = setTimeout(() => {
        failure = new Error("push(apns): no answer before the request deadline")
        stream.close(constants.NGHTTP2_CANCEL)
        conn.session.destroy()
      }, REQUEST_TIMEOUT_MS)
      stream.setEncoding("utf8")
      stream.on("response", (headers) => {
        status = String(headers[":status"] ?? "")
      })
      stream.on("data", (chunk: string) => {
        response += chunk
      })
      stream.on("error", (err) => {
        failure ??= err
      })
      stream.on("close", () => {
        clearTimeout(deadline)
        conn.inFlight--
        // A stream the server refused (past a GOAWAY's last stream id) was never processed, so it is safe
        // to send again; anything else may already have reached the device.
        if (stream.rstCode === constants.NGHTTP2_REFUSED_STREAM) resolve({ kind: "unprocessed" })
        else if (failure !== undefined || status === "") resolve({ kind: "failed", err: failure })
        else resolve({ kind: "answered", status, reason: reasonOf(response) })
      })
      stream.end(body)
    })
  }

  async function deliver(token: string, body: string): Promise<Outcome> {
    let jwt = currentJwt()
    let outcome = await post(token, body, jwt)
    if (outcome.kind === "unprocessed") {
      jwt = currentJwt()
      outcome = await post(token, body, jwt)
    }
    if (
      outcome.kind === "answered" &&
      outcome.status === "403" &&
      outcome.reason === EXPIRED_PROVIDER_TOKEN &&
      refreshAfterExpired(jwt)
    ) {
      outcome = await post(token, body, currentJwt())
    }
    return outcome
  }

  const dispatch: PlatformDispatcher = async (tokens, payload) => {
    // Signing first makes an unusable key fail the batch once, not once per device.
    currentJwt()
    const body = alertBody(payload)
    const invalidTokens: string[] = []
    await Promise.all(
      tokens.map((token) =>
        withSlot(async () => {
          let outcome: Outcome
          try {
            outcome = await deliver(token, body)
          } catch (err) {
            outcome = { kind: "failed", err }
          }
          const deviceHash = hashForLog(token)
          if (outcome.kind === "answered") {
            if (outcome.status === "200") return
            if (isApnsPruneFailure(outcome.status, outcome.reason)) {
              invalidTokens.push(token)
              return
            }
            logger.warn(
              { status: outcome.status, reason: outcome.reason, deviceHash },
              "push(apns): delivery failure",
            )
          } else {
            logger.warn(
              { err: outcome.kind === "failed" ? outcome.err : undefined, deviceHash },
              "push(apns): request failed",
            )
          }
        }),
      ),
    )
    return { invalidTokens }
  }

  dispatch.close = async () => {
    const open = connection?.session
    connection = null
    if (!open || open.destroyed) return
    const closed = new Promise<void>((resolve) => open.once("close", () => resolve()))
    open.close()
    await closed
  }

  return dispatch
}
