import { generateKeyPairSync } from "node:crypto"
import type { LightMyRequestResponse } from "fastify"
import { expect, vi } from "vitest"
import type { OAuthConfig } from "../../src/auth/oauth.js"
import type { AuthHarness } from "./auth.js"

// The real arctic clients run against a stubbed token endpoint, so the requests they send and the errors
// they throw are arctic's own.

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
export const APPLE_TOKEN_URL = "https://appleid.apple.com/auth/token"
export const WEB_ORIGIN = "https://app.civfix.org"

const APPLE_PRIVATE_KEY = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString()

export const OAUTH_CONFIG: OAuthConfig = {
  google: {
    clientId: "test-google-client",
    clientSecret: "test-google-secret",
    redirectUri: "http://localhost:8080/auth/google/callback",
  },
  apple: {
    clientId: "test-apple-client",
    teamId: "TEAMID",
    keyId: "KEYID",
    privateKey: APPLE_PRIVATE_KEY,
    redirectUri: "http://localhost:8080/auth/apple/callback",
    webClientId: "org.civfix.web",
  },
}

export interface TokenCall {
  url: string
  method: string
  body: URLSearchParams
}

export type ProviderAnswer = { status: number; body: string; contentType: string } | Error

export function json(status: number, body: unknown): ProviderAnswer {
  return { status, body: JSON.stringify(body), contentType: "application/json" }
}

export function html(status: number, body: string): ProviderAnswer {
  return { status, body, contentType: "text/html" }
}

export function stubTokenEndpoint(expectedUrl: string, answer: ProviderAnswer): TokenCall[] {
  const calls: TokenCall[] = []
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init)
    if (request.url !== expectedUrl) throw new Error(`unexpected fetch to ${request.url}`)
    calls.push({
      url: request.url,
      method: request.method,
      body: new URLSearchParams(await request.text()),
    })
    if (answer instanceof Error) throw answer
    return new Response(answer.body, {
      status: answer.status,
      headers: { "content-type": answer.contentType },
    })
  })
  return calls
}

function setCookieLines(setCookie: string | string[] | undefined): string[] {
  return Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : []
}

export function cookieValue(setCookie: string | string[] | undefined, name: string): string | null {
  for (const line of setCookieLines(setCookie)) {
    if (!line.startsWith(`${name}=`)) continue
    return decodeURIComponent(line.split(";")[0]!.slice(name.length + 1))
  }
  return null
}

export function clearsCookie(setCookie: string | string[] | undefined, name: string): boolean {
  return setCookieLines(setCookie).some((line) => line.startsWith(`${name}=;`))
}

export async function startHandshake(
  h: AuthHarness,
  provider: "google" | "apple",
  redirect?: string,
): Promise<{ state: string; cookie: string }> {
  const query = redirect === undefined ? "" : `?redirect=${encodeURIComponent(redirect)}`
  const start = await h.app.inject({ method: "GET", url: `/auth/${provider}/start${query}` })
  expect(start.statusCode).toBe(302)
  const state = new URL(start.headers.location as string).searchParams.get("state")!
  const handshake = cookieValue(start.headers["set-cookie"], "civfix_oauth")!
  return { state, cookie: `civfix_oauth=${encodeURIComponent(handshake)}` }
}

export interface CallbackResult {
  res: LightMyRequestResponse
  calls: TokenCall[]
}

export interface CallbackOptions {
  /** The `redirect` sign-in starts with. */
  redirect?: string
  /** The `state` sent back, when it is not the one this handshake was given. */
  state?: string
}

/** Starts Google sign-in on `h`, then calls the callback with `code=bad-code` against `answer`. */
export async function googleCallback(
  h: AuthHarness,
  answer: ProviderAnswer,
  opts: CallbackOptions = {},
): Promise<CallbackResult> {
  const { state, cookie } = await startHandshake(h, "google", opts.redirect)
  const calls = stubTokenEndpoint(GOOGLE_TOKEN_URL, answer)
  const res = await h.app.inject({
    method: "GET",
    url: `/auth/google/callback?code=bad-code&state=${encodeURIComponent(opts.state ?? state)}`,
    headers: { cookie },
  })
  return { res, calls }
}

/** Starts Apple sign-in on `h`, then form-posts the callback with `code=bad-code` against `answer`. */
export async function appleCallback(
  h: AuthHarness,
  answer: ProviderAnswer,
  opts: CallbackOptions = {},
): Promise<CallbackResult> {
  const { state, cookie } = await startHandshake(h, "apple", opts.redirect)
  const calls = stubTokenEndpoint(APPLE_TOKEN_URL, answer)
  const res = await h.app.inject({
    method: "POST",
    url: "/auth/apple/callback",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    payload: new URLSearchParams({ code: "bad-code", state: opts.state ?? state }).toString(),
  })
  return { res, calls }
}
