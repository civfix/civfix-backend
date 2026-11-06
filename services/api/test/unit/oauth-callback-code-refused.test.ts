import { Writable } from "node:stream"
import { afterEach, describe, expect, it, vi } from "vitest"
import { AppError, ErrorCode } from "@civfix/contract"
import type { VerifiedIdToken } from "../../src/auth/jwks.js"
import { makeAuthHarness, type AuthHarness } from "../helpers/auth.js"
import {
  OAUTH_CONFIG,
  WEB_ORIGIN,
  appleCallback,
  clearsCookie,
  cookieValue,
  googleCallback,
  html,
  json,
  type CallbackOptions,
  type ProviderAnswer,
} from "../helpers/oauth-provider.js"

// A provider refusing the authorization code (an expired, reused or revoked code) ends web sign-in the way
// a cancel at the provider does: back to the saved web target, no session. Every other failure keeps its
// own answer.

const REFUSAL = json(400, { error: "invalid_grant", error_description: "refusal-detail-7f3" })
const TOKENS = (idToken: string): ProviderAnswer =>
  json(200, { access_token: "a", token_type: "Bearer", expires_in: 3600, id_token: idToken })

interface LogLine {
  level: number
  providerError?: unknown
}

let harness: AuthHarness | undefined

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  if (harness) {
    await harness.app.close()
    harness = undefined
  }
})

function logCapture(): { lines: string[]; server: Parameters<typeof makeAuthHarness>[0] } {
  const lines: string[] = []
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      lines.push(...chunk.toString("utf8").split("\n").filter(Boolean))
      done()
    },
  })
  return {
    lines,
    server: {
      webOrigins: [WEB_ORIGIN],
      oauthConfig: OAUTH_CONFIG,
      server: { logCapture: { level: "info", stream } },
    },
  }
}

interface CaseOptions extends CallbackOptions {
  harnessOptions?: Parameters<typeof makeAuthHarness>[0]
  arrange?: (h: AuthHarness) => void
}

async function harnessFor(opts: CaseOptions): Promise<AuthHarness> {
  harness = await makeAuthHarness(
    opts.harnessOptions ?? { webOrigins: [WEB_ORIGIN], oauthConfig: OAUTH_CONFIG },
  )
  opts.arrange?.(harness)
  return harness
}

async function google(answer: ProviderAnswer, opts: CaseOptions = {}) {
  return googleCallback(await harnessFor(opts), answer, opts)
}

async function apple(answer: ProviderAnswer, opts: CaseOptions = {}) {
  return appleCallback(await harnessFor(opts), answer, opts)
}

function noSession(setCookie: string | string[] | undefined): void {
  expect(cookieValue(setCookie, "civfix_session")).toBeNull()
}

function expectRefusalLoggedOnce(lines: string[]): void {
  const parsed = lines.map((line) => JSON.parse(line) as LogLine)
  const refusals = parsed.filter((line) => "providerError" in line)
  expect(refusals).toHaveLength(1)
  expect(refusals[0]!.level).toBe(30)
  expect(refusals[0]!.providerError).toBe("invalid_grant")
  for (const line of lines) {
    expect(line).not.toContain("bad-code")
    expect(line).not.toContain("refusal-detail-7f3")
  }
  expect(parsed.filter((line) => line.level >= 50)).toEqual([])
}

const rejectSignature = (h: AuthHarness): void => {
  vi.spyOn(h.verifier, "verify").mockRejectedValue(
    AppError.unauthorized("Identity token signature is invalid."),
  )
}

const failDatabase =
  (idToken: string) =>
  (h: AuthHarness): void => {
    const claims: VerifiedIdToken = {
      sub: `${idToken}-sub`,
      email: null,
      emailVerified: false,
      name: null,
      picture: null,
    }
    h.verifier.register(idToken, claims)
    vi.spyOn(h.stores.oauth, "findByProvider").mockRejectedValue(new Error("db down"))
  }

describe("Google callback when Google refuses the code", () => {
  it("T1: redirects to the saved target, clears the state cookie and issues no session", async () => {
    const { res, calls } = await google(REFUSAL, { redirect: "/reports/7" })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe("/reports/7")
    expect(clearsCookie(res.headers["set-cookie"], "civfix_oauth")).toBe(true)
    noSession(res.headers["set-cookie"])
    expect(calls).toHaveLength(1)
  })

  it("T2: with no saved target, redirects to the first web origin", async () => {
    const { res } = await google(REFUSAL)
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe(WEB_ORIGIN)
    expect(clearsCookie(res.headers["set-cookie"], "civfix_oauth")).toBe(true)
    noSession(res.headers["set-cookie"])
  })

  it("T5: logs the refusal once at info with the provider's error code only", async () => {
    const capture = logCapture()
    await google(REFUSAL, { redirect: "/reports/7", harnessOptions: capture.server })
    expectRefusalLoggedOnce(capture.lines)
  })
})

describe("Apple callback when Apple refuses the code", () => {
  it("T3: redirects to the saved target, clears the state cookie and issues no session", async () => {
    const { res, calls } = await apple(REFUSAL, { redirect: "/events" })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe("/events")
    expect(clearsCookie(res.headers["set-cookie"], "civfix_oauth")).toBe(true)
    noSession(res.headers["set-cookie"])
    expect(calls).toHaveLength(1)
  })

  it("T4: with no saved target, redirects to the first web origin", async () => {
    const { res } = await apple(REFUSAL)
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe(WEB_ORIGIN)
    expect(clearsCookie(res.headers["set-cookie"], "civfix_oauth")).toBe(true)
    noSession(res.headers["set-cookie"])
  })

  it("T6: logs the refusal once at info with the provider's error code only", async () => {
    const capture = logCapture()
    await apple(REFUSAL, { redirect: "/events", harnessOptions: capture.server })
    expectRefusalLoggedOnce(capture.lines)
  })
})

describe("other callback failures keep their answers", () => {
  it("T7: a 400 with an HTML body is not a refusal: 500 INTERNAL, no session", async () => {
    const { res } = await google(html(400, "<html>bad</html>"))
    expect(res.statusCode).toBe(500)
    expect(res.json().code).toBe(ErrorCode.INTERNAL)
    noSession(res.headers["set-cookie"])
  })

  it("T8: Google, a rejected ID token is a 401 with no redirect and no session", async () => {
    const { res } = await google(TOKENS("g-id"), { arrange: rejectSignature })
    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe(ErrorCode.UNAUTHORIZED)
    expect(res.headers.location).toBeUndefined()
    noSession(res.headers["set-cookie"])
  })

  it("T9: Apple, a rejected ID token is a 401 with no redirect and no session", async () => {
    const { res } = await apple(TOKENS("a-id"), { arrange: rejectSignature })
    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe(ErrorCode.UNAUTHORIZED)
    expect(res.headers.location).toBeUndefined()
    noSession(res.headers["set-cookie"])
  })

  it("T10: Google, a database error is a 500 INTERNAL with no redirect and no session", async () => {
    const { res } = await google(TOKENS("g-id"), { arrange: failDatabase("g-id") })
    expect(res.statusCode).toBe(500)
    expect(res.json().code).toBe(ErrorCode.INTERNAL)
    expect(res.headers.location).toBeUndefined()
    noSession(res.headers["set-cookie"])
  })

  it("T11: Apple, a database error is a 500 INTERNAL with no redirect and no session", async () => {
    const { res } = await apple(TOKENS("a-id"), { arrange: failDatabase("a-id") })
    expect(res.statusCode).toBe(500)
    expect(res.json().code).toBe(ErrorCode.INTERNAL)
    expect(res.headers.location).toBeUndefined()
    noSession(res.headers["set-cookie"])
  })

  it("T12: someone else's state is a 401 before any exchange, and the state cookie stays", async () => {
    const { res, calls } = await google(REFUSAL, { state: "someone-elses-state" })
    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe(ErrorCode.UNAUTHORIZED)
    expect(calls).toHaveLength(0)
    expect(clearsCookie(res.headers["set-cookie"], "civfix_oauth")).toBe(false)
  })
})
