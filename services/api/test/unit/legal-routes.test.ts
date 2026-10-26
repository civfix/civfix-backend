import { afterEach, describe, expect, it } from "vitest"
import type { FastifyInstance } from "fastify"
import { FakeMailer } from "@civfix/seams"
import {
  GetLegalDocumentResponseSchema,
  GetLegalDocumentsResponseSchema,
  GetLegalVersionsResponseSchema,
} from "@civfix/contract"
import { makeServer } from "../../src/server.js"
import { loadEnv } from "../../src/env.js"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { makeInMemoryStores } from "../../src/auth/stores.js"
import { makeAuthServices, type AuthServices } from "../../src/auth/auth-services.js"
import { StubJwksVerifier } from "../helpers/auth.js"
import {
  InMemoryLegalDocumentsRepository,
  type StoredLegalDocument,
} from "../helpers/legal-documents-repository.memory.js"
import {
  FUTURE_PRIVACY,
  NEW_BLOCKS,
  NEW_TERMS,
  PRE_EPIC,
  TEST_NOW,
  defaultRows,
  keyOf,
  storedRow,
} from "../helpers/legal-fixtures.js"

const OPERATOR_EMAIL = "ops@civfix.org"
const PUBLIC_CACHE = "public, max-age=300"

interface Harness {
  app: FastifyInstance
  services: AuthServices
  stores: ReturnType<typeof makeInMemoryStores>
}

let current: Harness | undefined

afterEach(async () => {
  await current?.app.close()
  current = undefined
})

async function harness(rows: readonly StoredLegalDocument[] = defaultRows()): Promise<Harness> {
  const stores = makeInMemoryStores()
  const services = makeAuthServices({
    stores,
    cache: new InMemoryCacheClient(() => Date.now()),
    mailer: new FakeMailer(),
    oauthConfig: {},
    verifier: new StubJwksVerifier(),
    now: () => Date.now(),
  })
  const env = loadEnv({ NODE_ENV: "test", ADMIN_EMAILS: OPERATOR_EMAIL })
  const app = await makeServer({ env, authServices: services })
  app.legalOverrides = {
    repo: new InMemoryLegalDocumentsRepository(rows),
    now: () => TEST_NOW,
  }
  current = { app, services, stores }
  return current
}

async function sessionFor(
  h: Harness,
  email: string,
  role: "operator" | "citizen",
): Promise<string> {
  const user = await h.stores.users.create(email, {
    displayName: role,
    role,
    emailVerified: true,
  })
  return h.services.sessions.createSession(user.id, [role])
}

const preEpicNulls = { title: null, summary: null, material: null, blocks: null }

function documentOf(key: string): Record<string, unknown> {
  const entry = [...PRE_EPIC, NEW_TERMS, FUTURE_PRIVACY].find((e) => keyOf(e) === key)
  if (entry === undefined) throw new Error(`no fixture ${key}`)
  const isNew = entry.title !== undefined
  return {
    type: entry.type,
    version: entry.version,
    effectiveAt: entry.effectiveAt,
    url: entry.url,
    sha256: entry.sha256,
    ...(isNew
      ? {
          title: entry.title,
          summary: entry.summary,
          material: entry.material,
          blocks: NEW_BLOCKS,
        }
      : preEpicNulls),
  }
}

describe("GET /legal/documents", () => {
  it("T12: serves the current version of each served type with its blocks", async () => {
    const h = await harness()
    const res = await h.app.inject({ method: "GET", url: "/v1/legal/documents" })

    expect(res.statusCode).toBe(200)
    expect(res.headers["cache-control"]).toBe(PUBLIC_CACHE)
    const body = GetLegalDocumentsResponseSchema.parse(res.json())
    expect(body.documents).toEqual([
      documentOf("terms@2026-10-26"),
      documentOf("privacy@2026-09-21"),
      documentOf("cookies@2026-09-16"),
      documentOf("subprocessors@2026-09-16"),
    ])
    expect(body.documents.some((d) => (d.type as string) === "donations")).toBe(false)
  })

  it("T13: an empty table serves no documents", async () => {
    const h = await harness([])
    const res = await h.app.inject({ method: "GET", url: "/v1/legal/documents" })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ documents: [] })
  })
})

describe("GET /legal/documents/:type/:version", () => {
  it("T14: serves a new-style version with its blocks", async () => {
    const h = await harness()
    const res = await h.app.inject({ method: "GET", url: "/v1/legal/documents/terms/2026-10-26" })

    expect(res.statusCode).toBe(200)
    expect(res.headers["cache-control"]).toBe(PUBLIC_CACHE)
    const body = GetLegalDocumentResponseSchema.parse(res.json())
    expect(body).toEqual({ document: documentOf("terms@2026-10-26") })
  })

  it("T15: serves a pre-epic version with null text fields", async () => {
    const h = await harness()
    const res = await h.app.inject({
      method: "GET",
      url: "/v1/legal/documents/privacy/2026-09-16",
    })

    expect(res.statusCode).toBe(200)
    const { document } = res.json<{ document: Record<string, unknown> }>()
    expect(document).toMatchObject({
      ...preEpicNulls,
      sha256: "d3789e993ddee83cb5c556234694a9d0f200e5d99b533eba6ca3ca2053df9417",
      effectiveAt: "2026-09-16T00:00:00.000Z",
    })
  })

  it("T16: serves a version that is not in effect yet", async () => {
    const h = await harness()
    const res = await h.app.inject({
      method: "GET",
      url: "/v1/legal/documents/privacy/2026-11-01",
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ document: documentOf("privacy@2026-11-01") })
  })

  it("T17: 404s an unknown version and keeps it out of caches", async () => {
    const h = await harness()
    const res = await h.app.inject({ method: "GET", url: "/v1/legal/documents/terms/2026-01-01" })

    expect(res.statusCode).toBe(404)
    expect(res.json<{ code: string }>().code).toBe("NOT_FOUND")
    expect(res.headers["cache-control"]).toBe("no-store")
  })

  it.each(["/v1/legal/documents/donations/2026-09-06", "/v1/legal/documents/terms/not-a-date"])(
    "T18: rejects %s as a validation error, not cached",
    async (url) => {
      const h = await harness()
      const res = await h.app.inject({ method: "GET", url })

      expect(res.statusCode).toBe(422)
      expect(res.json<{ code: string }>().code).toBe("VALIDATION")
      expect(res.headers["cache-control"]).not.toBe(PUBLIC_CACHE)
    },
  )
})

describe("GET /legal/versions", () => {
  it("T19: keeps its shape and serves the current row per served type", async () => {
    const h = await harness()
    const res = await h.app.inject({ method: "GET", url: "/v1/legal/versions" })

    expect(res.statusCode).toBe(200)
    expect(res.headers["cache-control"]).toBe(PUBLIC_CACHE)
    const raw = res.json<{ documents: Record<string, unknown>[]; generatedAt: string }>()
    GetLegalVersionsResponseSchema.parse(raw)
    expect(raw.generatedAt).toBe("2026-10-26T12:00:00.000Z")
    const meta = (key: string): Record<string, unknown> => {
      const { blocks: _blocks, title, summary, material, ...rest } = documentOf(key)
      return title === null ? rest : { ...rest, title, summary, material }
    }
    expect(raw.documents).toEqual([
      meta("terms@2026-10-26"),
      meta("privacy@2026-09-21"),
      meta("cookies@2026-09-16"),
      meta("subprocessors@2026-09-16"),
    ])
    expect(raw.documents[0]).toMatchObject({ material: false })
    for (const entry of raw.documents.slice(1)) {
      expect(Object.keys(entry).sort()).toEqual(["effectiveAt", "sha256", "type", "url", "version"])
    }
  })

  it("T20: serves the table, not the contract", async () => {
    const rows = PRE_EPIC.filter((entry) => keyOf(entry) !== "terms@2026-09-21").map((entry) =>
      storedRow(entry),
    )
    const h = await harness(rows)
    const res = await h.app.inject({ method: "GET", url: "/v1/legal/versions" })

    expect(res.statusCode).toBe(200)
    const terms = res
      .json<{ documents: { type: string; version: string }[] }>()
      .documents.find((d) => d.type === "terms")
    expect(terms?.version).toBe("2026-09-16")
  })
})

describe("GET /admin/legal/versions", () => {
  it("T21: lists every version of the served types, newest first, with the record fields", async () => {
    const h = await harness()
    const token = await sessionFor(h, OPERATOR_EMAIL, "operator")
    const res = await h.app.inject({
      method: "GET",
      url: "/v1/admin/legal/versions",
      headers: { authorization: `Bearer ${token}` },
    })

    expect(res.statusCode).toBe(200)
    const documents = res.json<{ documents: Record<string, unknown>[] }>().documents
    expect(documents.map((d) => `${String(d.type)}@${String(d.version)}`)).toEqual([
      "privacy@2026-11-01",
      "terms@2026-10-26",
      "terms@2026-09-21",
      "privacy@2026-09-21",
      "terms@2026-09-16",
      "privacy@2026-09-16",
      "cookies@2026-09-16",
      "subprocessors@2026-09-16",
      "terms@2026-09-06",
      "privacy@2026-09-06",
      "cookies@2026-09-06",
      "subprocessors@2026-09-06",
    ])
    for (const entry of documents) {
      const isNew = entry.version === "2026-11-01" || entry.version === "2026-10-26"
      for (const key of ["title", "summary", "material"]) {
        expect(key in entry, `${String(entry.type)}@${String(entry.version)} ${key}`).toBe(isNew)
      }
      expect("acceptedCount" in entry).toBe(false)
      expect("activeAccounts" in entry).toBe(false)
    }
    expect(documents[0]).toMatchObject({
      title: "Privacy Notice",
      summary: "No change in wording",
      material: false,
    })
  })

  it("T22: a citizen gets the operator plane's existing refusal", async () => {
    const h = await harness()
    const token = await sessionFor(h, "neighbor@example.org", "citizen")
    const headers = { authorization: `Bearer ${token}` }
    const res = await h.app.inject({ method: "GET", url: "/v1/admin/legal/versions", headers })
    const sibling = await h.app.inject({ method: "GET", url: "/v1/admin/orgs", headers })

    expect(res.statusCode).toBe(sibling.statusCode)
    expect(res.json<{ code: string }>().code).toBe(sibling.json<{ code: string }>().code)
    expect(res.statusCode).toBe(403)
  })
})

describe("public legal reads", () => {
  it.each(["/v1/legal/documents", "/v1/legal/documents/terms/2026-10-26"])(
    "T23: %s answers 429 on the 121st request in a minute from one host",
    async (url) => {
      const h = await harness()
      for (let i = 0; i < 120; i++) {
        const ok = await h.app.inject({ method: "GET", url })
        expect(ok.statusCode, `request ${i + 1}`).toBe(200)
      }
      const limited = await h.app.inject({ method: "GET", url })

      expect(limited.statusCode).toBe(429)
      expect(limited.json<{ code: string }>().code).toBe("RATE_LIMITED")
    },
  )
})
