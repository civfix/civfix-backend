import { afterEach, describe, expect, it } from "vitest"
import type { FastifyInstance } from "fastify"
import { buildServer } from "../../src/server.js"
import { buildContainer, type Container } from "../../src/di.js"
import { loadEnv } from "../../src/env.js"
import { makeFakeSql, type FakeSqlControl } from "../helpers/fake-sql.js"

const SUGGEST_URL = "/v1/map/jurisdictions/0644000/suggest-contact"

let app: FastifyInstance | undefined

afterEach(async () => {
  if (app) {
    await app.close()
    app = undefined
  }
})

async function boot(): Promise<FakeSqlControl> {
  const env = loadEnv({ NODE_ENV: "test" })
  const db = makeFakeSql([
    { match: /FROM jurisdictions/, rows: [{ "?column?": 1 }] },
    { match: /INSERT INTO audit_log/, rows: [{ id: "audit-1" }] },
  ])
  const container = {
    ...buildContainer(env),
    getDb: () => ({ sql: db.sql }),
  } as unknown as Container
  app = await buildServer({ env, container })
  return db
}

function auditWrites(db: FakeSqlControl): number {
  return db.statements.filter((s) => /INSERT INTO audit_log/.test(s.sql)).length
}

describe("POST /map/jurisdictions/:geoid/suggest-contact: bounded fields", () => {
  it("accepts a normal suggestion and writes one audit row", async () => {
    const db = await boot()
    const res = await app!.inject({
      method: "POST",
      url: SUGGEST_URL,
      payload: { email: "clerk@city.example.gov", formUrl: "https://city.example.gov/report" },
    })
    expect(res.statusCode).toBe(201)
    expect(auditWrites(db)).toBe(1)
  })

  it("422s an email longer than an address can be, before any write", async () => {
    const db = await boot()
    const res = await app!.inject({
      method: "POST",
      url: SUGGEST_URL,
      payload: { email: `a@${"x".repeat(300)}.com` },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().fields).toHaveProperty("email")
    expect(auditWrites(db)).toBe(0)
  })

  it("422s an overlong form URL, before any write", async () => {
    const db = await boot()
    const res = await app!.inject({
      method: "POST",
      url: SUGGEST_URL,
      payload: { formUrl: `https://city.example.gov/${"y".repeat(3000)}` },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().fields).toHaveProperty("formUrl")
    expect(auditWrites(db)).toBe(0)
  })

  it("422s a form URL that is not an http(s) link", async () => {
    const db = await boot()
    const res = await app!.inject({
      method: "POST",
      url: SUGGEST_URL,
      payload: { formUrl: "javascript:alert(1)" },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().fields).toHaveProperty("formUrl")
    expect(auditWrites(db)).toBe(0)
  })

  it("422s an overlong geoid path segment", async () => {
    const db = await boot()
    const res = await app!.inject({
      method: "POST",
      url: `/v1/map/jurisdictions/${"9".repeat(80)}/suggest-contact`,
      payload: { email: "clerk@city.example.gov" },
    })
    expect(res.statusCode).toBe(422)
    expect(auditWrites(db)).toBe(0)
  })

  it("refuses a body far larger than any valid suggestion", async () => {
    const db = await boot()
    const res = await app!.inject({
      method: "POST",
      url: SUGGEST_URL,
      payload: { email: "clerk@city.example.gov", padding: "z".repeat(100_000) },
    })
    expect(res.statusCode).toBe(413)
    expect(auditWrites(db)).toBe(0)
  })
})
