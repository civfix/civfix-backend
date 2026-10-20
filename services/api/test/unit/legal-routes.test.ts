import Fastify, { type FastifyInstance } from "fastify"
import { afterEach, describe, expect, it } from "vitest"
import type { GetLegalVersionsResponse } from "@civfix/contract"
import { endpoints, versionedPath } from "@civfix/contract/client"
import type { Container } from "../../src/di.js"
import { registerLegalRoutes } from "../../src/routes/legal.routes.js"

let app: FastifyInstance | undefined

afterEach(async () => {
  await app?.close()
  app = undefined
})

describe("GET /legal/versions", () => {
  it("T3: serves terms and privacy at 2026-10-20, cookies and subprocessors at 2026-09-16", async () => {
    app = Fastify()
    await registerLegalRoutes(app, {} as Container)
    await app.ready()

    const res = await app.inject({ method: "GET", url: versionedPath(endpoints.getLegalVersions) })

    expect(res.statusCode).toBe(200)
    const { documents } = res.json<GetLegalVersionsResponse>()
    const byType = (type: string) => documents.find((document) => document.type === type)
    expect(byType("terms")).toMatchObject({
      version: "2026-10-20",
      sha256: "942aabae31cda45d9cdace018ee0953d28506b27d2f0c45b2d3cd554cfa66ed3",
      effectiveAt: "2026-10-20T00:00:00.000Z",
    })
    expect(byType("privacy")).toMatchObject({
      version: "2026-10-20",
      sha256: "05dedba2376323c94697e2bfb43915f6b983761b806b74ba336d46c2f991ff8a",
      effectiveAt: "2026-10-20T00:00:00.000Z",
    })
    expect(byType("cookies")?.version).toBe("2026-09-16")
    expect(byType("subprocessors")?.version).toBe("2026-09-16")
  })
})
