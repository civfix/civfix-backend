import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { endpoints } from "@civfix/shared/client"
import type { EndpointName, RouteOptions } from "../../src/versioning/route.js"
import { makeAuthHarness, type AuthHarness } from "../helpers/auth.js"

// The registry's `csrf: true` flag does not wire the preHandler (route() copies only method and path), so
// the pairing is a hand-kept convention. This pins it: every cookie-authenticated mutation must run
// csrfProtect, and each exception is listed here with the reason it is safe, so a new unpaired mutation
// fails CI until someone either pairs it or argues for it in review.

const registered = vi.hoisted(() => new Map<string, RouteOptions>())

vi.mock("../../src/versioning/route.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/versioning/route.js")>()
  const record = (...args: Parameters<typeof actual.route>): void => {
    const [app, name, optsOrHandler, maybeHandler] = args as unknown as [
      Parameters<typeof actual.route>[0],
      EndpointName,
      RouteOptions | (() => unknown),
      (() => unknown) | undefined,
    ]
    registered.set(name, maybeHandler ? (optsOrHandler as RouteOptions) : {})
    ;(actual.route as (...a: unknown[]) => void)(app, name, optsOrHandler, maybeHandler)
  }
  return { ...actual, route: record }
})

const SIGN_IN = "sign-in: runs before any session exists, so there is no session to ride"
const PUBLIC = "public: the handler never reads the session, so a forged request gains nothing"
const READ_OVER_POST = "read over POST: returns a lookup and changes no state"
const UNDER_REVIEW = "under review in the backend cleanup campaign"

const CSRF_EXEMPT: Readonly<Record<string, string>> = {
  otpRequest: SIGN_IN,
  otpVerify: SIGN_IN,
  appleSignIn: SIGN_IN,
  googleSignIn: SIGN_IN,
  appleCallback: SIGN_IN,
  adminAccessExchange: SIGN_IN,
  resolveJurisdiction: READ_OVER_POST,
  reverseLabel: READ_OVER_POST,
  resolveAddress: READ_OVER_POST,
  suggest: READ_OVER_POST,
  getFeedCounts: READ_OVER_POST,
  getGuestEventTicket: READ_OVER_POST,
  suggestJurisdictionContact: PUBLIC,
  anonCreateReport: PUBLIC,
  guestRsvpRequest: PUBLIC,
  guestRsvpVerify: PUBLIC,
  guestRsvpCancel: PUBLIC,
  recordEventPageView: PUBLIC,
  unsubscribeBroadcasts:
    "public one-click unsubscribe (RFC 8058): the signed token, not a session, is the capability",
  createMediaUpload: UNDER_REVIEW,
  finalizeMedia: UNDER_REVIEW,
  claimNudge: UNDER_REVIEW,
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"])

let harness: AuthHarness

beforeAll(async () => {
  harness = await makeAuthHarness()
})

afterAll(async () => {
  await harness.app.close()
})

function preHandlersOf(name: string): unknown[] {
  const pre = registered.get(name)?.preHandler
  if (pre === undefined) return []
  return Array.isArray(pre) ? pre : [pre]
}

describe("CSRF pairing: every mutation runs csrfProtect or is a reviewed exception", () => {
  const mutations = Object.entries(endpoints)
    .filter(([, ep]) => MUTATING.has(ep.method))
    .map(([name]) => name)

  it("sees every mutation in the registry registered", () => {
    const missing = mutations.filter((name) => !registered.has(name))
    expect(missing).toEqual([])
  })

  it.each(mutations)("%s", (name) => {
    const paired = preHandlersOf(name).includes(harness.container.csrf.protect)
    if (name in CSRF_EXEMPT) {
      expect(paired, `${name} is paired now; drop it from CSRF_EXEMPT`).toBe(false)
    } else {
      expect(
        paired,
        `${name} mutates without csrfProtect; pair it or add a reviewed exemption`,
      ).toBe(true)
    }
  })

  it("lists only real mutations as exemptions", () => {
    const stale = Object.keys(CSRF_EXEMPT).filter((name) => !mutations.includes(name))
    expect(stale).toEqual([])
  })
})
