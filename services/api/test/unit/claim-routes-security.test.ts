import { afterEach, describe, expect, it } from "vitest"
import type { FastifyInstance } from "fastify"
import { makeServer } from "../../src/server.js"
import { loadEnv } from "../../src/env.js"
import type { ClaimService } from "../../src/services/claim-service.js"

const WEB_ORIGIN = "https://civfix.org"
const REPORT_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
const COOKIE_TOKEN = "cookie-anon-token"
const BODY_TOKEN = "body-anon-token"

let app: FastifyInstance | undefined

afterEach(async () => {
  await app?.close()
  app = undefined
})

async function serverWithNudges(): Promise<{ app: FastifyInstance; nudged: string[] }> {
  const nudged: string[] = []
  const service: ClaimService = {
    claimNudge: (anonToken) => {
      nudged.push(anonToken)
      return Promise.resolve({ reportId: REPORT_ID, claimCode: "fresh-code" })
    },
    claimReport: () => Promise.reject(new Error("unused")),
  }
  app = await makeServer({
    env: loadEnv({ NODE_ENV: "test", WEB_ORIGINS: WEB_ORIGIN }),
    claimOverride: { service },
  })
  return { app, nudged }
}

function nudge(target: FastifyInstance, headers: Record<string, string>, payload?: object) {
  return target.inject({
    method: "POST",
    url: "/v1/claim/nudge",
    headers: { cookie: `civfix_anon=${COOKIE_TOKEN}`, ...headers },
    ...(payload !== undefined ? { payload } : {}),
  })
}

describe("POST /claim/nudge origin guard on the cookie path", () => {
  it("refuses a cookie-borne nudge from an origin outside the web allowlist", async () => {
    const h = await serverWithNudges()

    const res = await nudge(h.app, { origin: "https://evil.civfix.org" })

    expect(res.statusCode).toBe(403)
    expect(h.nudged).toEqual([])
  })

  it("refuses a cookie-borne nudge from an opaque origin", async () => {
    const h = await serverWithNudges()

    const res = await nudge(h.app, { origin: "null" }, {})

    expect(res.statusCode).toBe(403)
    expect(h.nudged).toEqual([])
  })

  it("serves the first-party web app's cookie nudge", async () => {
    const h = await serverWithNudges()

    const res = await nudge(h.app, { origin: WEB_ORIGIN }, {})

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ reportId: REPORT_ID })
    expect(h.nudged).toEqual([COOKIE_TOKEN])
  })

  it("serves a cookie nudge with no Origin, which no browser sends on a cross-site POST", async () => {
    const h = await serverWithNudges()

    const res = await nudge(h.app, {}, {})

    expect(res.statusCode).toBe(200)
    expect(h.nudged).toEqual([COOKIE_TOKEN])
  })

  it("leaves the body-token path untouched whatever the origin", async () => {
    const h = await serverWithNudges()

    const res = await nudge(h.app, { origin: "https://evil.example" }, { anonToken: BODY_TOKEN })

    expect(res.statusCode).toBe(200)
    expect(h.nudged).toEqual([BODY_TOKEN])
  })
})
