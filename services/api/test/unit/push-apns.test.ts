// The APNs client runs against a local cleartext HTTP/2 server: node:http2's connect is wrapped so the
// authority the dispatcher asks for is recorded and the session goes to the test server instead, and only
// Date is faked so the provider-token clock moves while sockets run on real time. No test reaches Apple.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as http2 from "node:http2"
import type {
  ClientHttp2Session,
  IncomingHttpHeaders,
  ServerHttp2Session,
  ServerHttp2Stream,
} from "node:http2"
import { generateKeyPairSync, verify, type KeyObject } from "node:crypto"
import type { AddressInfo } from "node:net"
import { makeApnsDispatcher } from "../../src/adapters/push-apns.js"
import {
  hashForLog,
  type PushLogger,
  type PushSenderConfig,
} from "../../src/adapters/push-sender.js"

const h2 = vi.hoisted(() => ({
  target: "",
  authorities: [] as string[],
  clientSessions: [] as import("node:http2").ClientHttp2Session[],
}))

vi.mock("node:http2", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:http2")>()
  const connect = ((authority: string | URL, ...rest: unknown[]) => {
    h2.authorities.push(String(authority))
    const session = (actual.connect as (...args: unknown[]) => ClientHttp2Session)(
      h2.target,
      ...rest,
    )
    h2.clientSessions.push(session)
    return session
  }) as typeof actual.connect
  return { ...actual, connect, default: { ...actual, connect } }
})

const MINUTE = 60_000
const T0 = new Date("2026-10-23T10:00:00.000Z").getTime()

const D1 = "a".repeat(64)
const P = {
  title: "Hi",
  body: "There",
  link: "/reports/r1",
  data: { type: "report_update", link: "/ignored" },
}

function deviceToken(n: number): string {
  return n.toString(16).padStart(64, "0")
}

interface Keys {
  privateKey: string
  publicKey: KeyObject
}

function makeKeys(): Keys {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" })
  return {
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey,
  }
}

function apnsConfig(keys: Keys, production = false): NonNullable<PushSenderConfig["apns"]> {
  return {
    keyId: "ABC123DEFG",
    teamId: "TEAM123456",
    privateKey: keys.privateKey,
    bundleId: "org.civfix.community",
    production,
  }
}

function recordingLogger(): { logger: PushLogger; logged: unknown[]; warns: unknown[] } {
  const logged: unknown[] = []
  const warns: unknown[] = []
  return {
    logger: {
      warn: (obj, msg) => {
        warns.push(obj)
        logged.push([obj, msg])
      },
      error: (obj, msg) => logged.push([obj, msg]),
    },
    logged,
    warns,
  }
}

interface Received {
  headers: IncomingHttpHeaders
  body: string
  jwt: string
  stream: ServerHttp2Stream
  session: ServerHttp2Session
}

interface TestServer {
  sessions: ServerHttp2Session[]
  requests: Received[]
  maxOpen: number
  handler: (req: Received) => void
  close(): Promise<void>
}

function answer(req: Received, status: number, reason?: string): void {
  req.stream.respond({ ":status": status })
  req.stream.end(reason === undefined ? "" : JSON.stringify({ reason }))
}

async function startServer(): Promise<TestServer> {
  const server = http2.createServer()
  let open = 0
  const state: TestServer = {
    sessions: [],
    requests: [],
    maxOpen: 0,
    handler: (req) => answer(req, 200),
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of state.sessions) s.destroy()
        server.close(() => resolve())
      }),
  }
  server.on("session", (session) => state.sessions.push(session))
  server.on("stream", (stream, headers) => {
    open++
    state.maxOpen = Math.max(state.maxOpen, open)
    stream.on("close", () => open--)
    // Resets in the failure cases surface here too; the client's side is what the tests assert.
    stream.on("error", () => {})
    let body = ""
    stream.setEncoding("utf8")
    stream.on("data", (chunk: string) => (body += chunk))
    stream.on("end", () => {
      const auth = String(headers.authorization ?? "")
      const req: Received = {
        headers,
        body,
        jwt: auth.replace(/^bearer /, ""),
        stream,
        session: stream.session as ServerHttp2Session,
      }
      state.requests.push(req)
      state.handler(req)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  h2.target = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return state
}

function decodePart(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>
}

function iatOf(jwt: string): number {
  return decodePart(jwt.split(".")[1] as string).iat as number
}

function closed(session: { destroyed: boolean; once(e: "close", l: () => void): unknown }) {
  return new Promise<void>((resolve) => {
    if (session.destroyed) resolve()
    else session.once("close", resolve)
  })
}

function at(ms: number): void {
  vi.setSystemTime(ms)
}

let server: TestServer
let keys: Keys
const dispatchers: { close?(): Promise<void> }[] = []

function dispatcherFor(logger: PushLogger, production = false) {
  const d = makeApnsDispatcher(apnsConfig(keys, production), logger)
  dispatchers.push(d)
  return d
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] })
  at(T0)
  h2.authorities.length = 0
  h2.clientSessions.length = 0
  keys = makeKeys()
  server = await startServer()
})

afterEach(async () => {
  for (const d of dispatchers.splice(0)) await d.close?.()
  await server.close()
  vi.useRealTimers()
})

describe("makeApnsDispatcher: the request", () => {
  it("T1: one POST to /3/device/<token> with the topic and a bearer JWT, resolving clean", async () => {
    const { logger, logged } = recordingLogger()
    const dispatch = dispatcherFor(logger)

    await expect(dispatch([D1], P)).resolves.toEqual({ invalidTokens: [] })

    expect(server.requests).toHaveLength(1)
    const { headers, jwt } = server.requests[0] as Received
    expect(headers[":method"]).toBe("POST")
    expect(headers[":path"]).toBe(`/3/device/${D1}`)
    expect(headers["apns-topic"]).toBe("org.civfix.community")
    expect(headers.authorization).toBe(`bearer ${jwt}`)
    expect(jwt.split(".")).toHaveLength(3)
    expect(logged).toEqual([])
  })

  it("T2: the body is today's alert payload, payload.link winning over data.link", async () => {
    const dispatch = dispatcherFor(recordingLogger().logger)
    await dispatch([D1], P)

    expect(JSON.parse((server.requests[0] as Received).body)).toEqual({
      type: "report_update",
      link: "/reports/r1",
      aps: { alert: { title: "Hi", body: "There" }, sound: "default" },
    })
  })

  it("T3: a title-only payload carries only the alert title and the sound", async () => {
    const dispatch = dispatcherFor(recordingLogger().logger)
    await dispatch([D1], { title: "Hi" })

    expect(JSON.parse((server.requests[0] as Received).body)).toEqual({
      aps: { alert: { title: "Hi" }, sound: "default" },
    })
  })

  it("T18: opens the production host when production is true, the sandbox host otherwise", async () => {
    await dispatcherFor(recordingLogger().logger, true)([D1], P)
    await dispatcherFor(recordingLogger().logger, false)([D1], P)

    expect(h2.authorities).toEqual([
      "https://api.push.apple.com:443",
      "https://api.sandbox.push.apple.com:443",
    ])
  })
})

describe("makeApnsDispatcher: the provider token", () => {
  it("T4: an ES256 JWT with kid and iss, iat in whole seconds and a raw 64-byte signature", async () => {
    at(T0 + 789)
    const dispatch = dispatcherFor(recordingLogger().logger)
    await dispatch([D1], P)

    const jwt = (server.requests[0] as Received).jwt
    const [header, claims, signature] = jwt.split(".") as [string, string, string]
    expect(decodePart(header)).toMatchObject({ alg: "ES256", kid: "ABC123DEFG" })
    expect(decodePart(claims)).toMatchObject({
      iss: "TEAM123456",
      iat: Math.floor((T0 + 789) / 1000),
    })
    const sig = Buffer.from(signature, "base64url")
    expect(sig).toHaveLength(64)
    expect(
      verify(
        "sha256",
        Buffer.from(`${header}.${claims}`),
        { key: keys.publicKey, dsaEncoding: "ieee-p1363" },
        sig,
      ),
    ).toBe(true)
  })

  it("T5: the same JWT is reused at 49 min 59 s", async () => {
    const dispatch = dispatcherFor(recordingLogger().logger)
    await dispatch([D1], P)
    at(T0 + 50 * MINUTE - 1000)
    await dispatch([D1], P)

    const [first, second] = server.requests as [Received, Received]
    expect(second.jwt).toBe(first.jwt)
  })

  it("T6: a new JWT is built at 50 min", async () => {
    const dispatch = dispatcherFor(recordingLogger().logger)
    await dispatch([D1], P)
    at(T0 + 50 * MINUTE)
    await dispatch([D1], P)

    const [first, second] = server.requests as [Received, Received]
    expect(second.jwt).not.toBe(first.jwt)
    expect(iatOf(second.jwt)).toBe((T0 + 50 * MINUTE) / 1000)
  })

  it("T7: a 403 ExpiredProviderToken after 25 min rebuilds the JWT and resends once", async () => {
    const { logger, logged } = recordingLogger()
    const dispatch = dispatcherFor(logger)
    await dispatch([D1], P)

    at(T0 + 25 * MINUTE)
    let calls = 0
    server.handler = (req) =>
      ++calls === 1 ? answer(req, 403, "ExpiredProviderToken") : answer(req, 200)
    await expect(dispatch([D1], P)).resolves.toEqual({ invalidTokens: [] })

    expect(server.requests).toHaveLength(3)
    const [first, expired, retry] = server.requests as [Received, Received, Received]
    expect(expired.jwt).toBe(first.jwt)
    expect(retry.jwt).not.toBe(first.jwt)
    expect(iatOf(retry.jwt)).toBe((T0 + 25 * MINUTE) / 1000)
    expect(logged).toEqual([])
  })

  it("T8: three concurrent ExpiredProviderToken answers rebuild the JWT once", async () => {
    const dispatch = dispatcherFor(recordingLogger().logger)
    await dispatch([D1], P)
    const firstJwt = (server.requests[0] as Received).jwt

    at(T0 + 25 * MINUTE)
    server.handler = (req) =>
      req.jwt === firstJwt ? answer(req, 403, "ExpiredProviderToken") : answer(req, 200)
    const tokens = [D1, deviceToken(2), deviceToken(3)]
    await expect(dispatch(tokens, P)).resolves.toEqual({ invalidTokens: [] })

    const retries = server.requests.slice(1).filter((r) => r.jwt !== firstJwt)
    expect(retries).toHaveLength(3)
    expect(new Set(retries.map((r) => r.jwt)).size).toBe(1)
    expect(retries.map((r) => r.headers[":path"]).sort()).toEqual(
      tokens.map((t) => `/3/device/${t}`).sort(),
    )
  })

  it("T9: an ExpiredProviderToken on a JWT under 20 min old is not retried and keeps the JWT", async () => {
    const { logger, logged, warns } = recordingLogger()
    const dispatch = dispatcherFor(logger)
    await dispatch([D1], P)
    const firstJwt = (server.requests[0] as Received).jwt

    at(T0 + 10 * MINUTE)
    server.handler = (req) => answer(req, 403, "ExpiredProviderToken")
    await expect(dispatch([D1], P)).resolves.toEqual({ invalidTokens: [] })
    expect(server.requests).toHaveLength(2)
    expect(logged).toHaveLength(1)
    expect(warns[0]).toMatchObject({ status: "403", reason: "ExpiredProviderToken" })

    at(T0 + 11 * MINUTE)
    server.handler = (req) => answer(req, 200)
    await dispatch([D1], P)
    expect(server.requests).toHaveLength(3)
    expect((server.requests[2] as Received).jwt).toBe(firstJwt)
  })
})

describe("makeApnsDispatcher: the session", () => {
  it("T10: sequential sends share one HTTP/2 session", async () => {
    const dispatch = dispatcherFor(recordingLogger().logger)
    await dispatch([D1], P)
    await dispatch([D1], P)
    await dispatch([D1], P)

    expect(server.sessions).toHaveLength(1)
    expect(server.requests).toHaveLength(3)
  })

  it("T11: after a GOAWAY the next send opens a new session", async () => {
    const dispatch = dispatcherFor(recordingLogger().logger)
    await dispatch([D1], P)
    ;(server.sessions[0] as ServerHttp2Session).goaway()
    await closed(h2.clientSessions[0] as ClientHttp2Session)

    await expect(dispatch([D1], P)).resolves.toEqual({ invalidTokens: [] })
    expect(server.sessions).toHaveLength(2)
    expect((server.requests[1] as Received).session).toBe(server.sessions[1])
  })

  it("T12: after the server drops the session the next send opens a new one", async () => {
    const dispatch = dispatcherFor(recordingLogger().logger)
    await dispatch([D1], P)
    ;(server.sessions[0] as ServerHttp2Session).destroy()
    await closed(h2.clientSessions[0] as ClientHttp2Session)

    await expect(dispatch([D1], P)).resolves.toEqual({ invalidTokens: [] })
    expect(server.sessions).toHaveLength(2)
    expect((server.requests[1] as Received).session).toBe(server.sessions[1])
  })

  it("a stream refused by a GOAWAY is sent again on a new session", async () => {
    const { logger, logged } = recordingLogger()
    const dispatch = dispatcherFor(logger)
    const D2 = deviceToken(2)
    let lastProcessed: number | undefined
    server.handler = (req) => {
      if (req.session !== server.sessions[0]) return answer(req, 200)
      if (lastProcessed !== undefined) return
      lastProcessed = req.stream.id
      req.session.goaway(http2.constants.NGHTTP2_NO_ERROR, lastProcessed)
      answer(req, 200)
    }

    await expect(dispatch([D1, D2], P)).resolves.toEqual({ invalidTokens: [] })
    expect(server.sessions).toHaveLength(2)
    const resent = server.requests.filter((r) => r.session === server.sessions[1])
    expect(resent).toHaveLength(1)
    expect(logged).toEqual([])
  })

  it("T13: at most 32 requests are open at once", async () => {
    const dispatch = dispatcherFor(recordingLogger().logger)
    const held: Received[] = []
    let released = false
    server.handler = (req) => {
      if (released) return answer(req, 200)
      held.push(req)
      if (held.length === 32) {
        released = true
        for (const r of held) answer(r, 200)
      }
    }
    const tokens = Array.from({ length: 100 }, (_, i) => deviceToken(i + 1))

    await expect(dispatch(tokens, P)).resolves.toEqual({ invalidTokens: [] })
    expect(server.maxOpen).toBe(32)
    expect(server.requests).toHaveLength(100)
  })

  it("T19: close() ends the open session; on an unused dispatcher it opens none", async () => {
    const dispatch = dispatcherFor(recordingLogger().logger)
    await dispatch([D1], P)
    const serverSession = server.sessions[0] as ServerHttp2Session
    const serverSaw = closed(serverSession)

    await dispatch.close?.()
    await serverSaw
    expect(serverSession.destroyed).toBe(true)

    const unused = dispatcherFor(recordingLogger().logger)
    await expect(unused.close?.()).resolves.toBeUndefined()
    expect(h2.authorities).toHaveLength(1)
    expect(server.sessions).toHaveLength(1)
  })
})

describe("makeApnsDispatcher: failures", () => {
  it("T15: 410 and the Unregistered / BadDeviceToken reasons prune, logging nothing", async () => {
    const { logger, logged } = recordingLogger()
    const dispatch = dispatcherFor(logger)
    const [A, B, C, E] = [1, 2, 3, 4].map(deviceToken) as [string, string, string, string]
    const answers: Record<string, [number, string]> = {
      [A]: [410, "Unregistered"],
      [B]: [410, "ExpiredToken"],
      [C]: [400, "BadDeviceToken"],
      [E]: [400, "Unregistered"],
    }
    server.handler = (req) => {
      const [status, reason] = answers[String(req.headers[":path"]).slice("/3/device/".length)]!
      answer(req, status, reason)
    }

    const { invalidTokens } = await dispatch([A, B, C, E], P)
    expect([...invalidTokens].sort()).toEqual([A, B, C, E].sort())
    expect(logged).toEqual([])
  })

  it("T16: other failures warn once per token with status, reason and a hash, never the secrets", async () => {
    const { logger, logged, warns } = recordingLogger()
    const dispatch = dispatcherFor(logger)
    const [F, G, H, I] = [5, 6, 7, 8].map(deviceToken) as [string, string, string, string]
    const answers: Record<string, [number, string]> = {
      [F]: [400, "BadTopic"],
      [G]: [429, "TooManyRequests"],
      [H]: [500, "InternalServerError"],
      [I]: [503, "ServiceUnavailable"],
    }
    server.handler = (req) => {
      const [status, reason] = answers[String(req.headers[":path"]).slice("/3/device/".length)]!
      answer(req, status, reason)
    }

    await expect(dispatch([F, G, H, I], P)).resolves.toEqual({ invalidTokens: [] })
    expect(warns).toHaveLength(4)
    for (const [token, [status, reason]] of Object.entries(answers)) {
      expect(warns).toContainEqual(
        expect.objectContaining({ status: String(status), reason, deviceHash: hashForLog(token) }),
      )
    }
    const all = JSON.stringify(logged)
    const jwt = (server.requests[0] as Received).jwt
    for (const secret of [F, G, H, I, jwt, "Hi", "There"]) expect(all).not.toContain(secret)
  })

  it("T17: a reset stream resolves and warns with the device hash only", async () => {
    const { logger, logged, warns } = recordingLogger()
    const dispatch = dispatcherFor(logger)
    server.handler = (req) => req.stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR)

    await expect(dispatch([D1], P)).resolves.toEqual({ invalidTokens: [] })
    expect(warns).toHaveLength(1)
    expect(warns[0]).toMatchObject({ deviceHash: hashForLog(D1) })
    const all = JSON.stringify(logged)
    expect(all).not.toContain(D1)
    expect(all).not.toContain((server.requests[0] as Received).jwt)
  })

  it("a request with no answer is abandoned after its deadline and the next send reconnects", async () => {
    vi.useRealTimers()
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] })
    at(T0)
    const { logger, warns } = recordingLogger()
    const dispatch = dispatcherFor(logger)
    const arrived = new Promise<void>((resolve) => (server.handler = () => resolve()))

    const pending = dispatch([D1], P)
    await Promise.race([arrived, pending])
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(pending).resolves.toEqual({ invalidTokens: [] })
    expect(warns).toHaveLength(1)
    expect(warns[0]).toMatchObject({ deviceHash: hashForLog(D1) })

    server.handler = (req) => answer(req, 200)
    await expect(dispatch([D1], P)).resolves.toEqual({ invalidTokens: [] })
    expect(server.sessions).toHaveLength(2)
  })
})
