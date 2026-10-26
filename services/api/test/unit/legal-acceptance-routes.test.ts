import { afterEach, describe, expect, it } from "vitest"
import type { FastifyInstance, LightMyRequestResponse } from "fastify"
import { FakeMailer } from "@civfix/seams"
import {
  AcceptLegalResponseSchema,
  LegalVersionOutdatedDetailsSchema,
  MyLegalStatusResponseSchema,
  type LegalDocumentType,
} from "@civfix/contract"
import { makeServer } from "../../src/server.js"
import { makeContainer, type Container } from "../../src/di.js"
import { loadEnv } from "../../src/env.js"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { makeInMemoryStores } from "../../src/auth/stores.js"
import { makeAuthServices, type AuthServices } from "../../src/auth/auth-services.js"
import { StubJwksVerifier } from "../helpers/auth.js"
import { InMemoryLegalDocumentsRepository } from "../helpers/legal-documents-repository.memory.js"
import {
  InMemoryLegalAcceptanceRepository,
  type StoredConsentRecord,
} from "../helpers/legal-acceptance-repository.memory.js"
import {
  C,
  CUR,
  DAY_MS,
  item,
  meta,
  outdatedDetails,
  sha,
  vRows,
} from "../helpers/legal-acceptance-fixtures.js"

const OPERATOR_EMAIL = "ops@civfix.org"

interface Person {
  userId: string
  token: string
  csrfToken: string
}

interface Harness {
  app: FastifyInstance
  container: Container
  services: AuthServices
  stores: ReturnType<typeof makeInMemoryStores>
  acceptances: InMemoryLegalAcceptanceRepository
  setClock(at: Date): void
}

let current: Harness | undefined

afterEach(async () => {
  await current?.app.close()
  current = undefined
})

async function harness(): Promise<Harness> {
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
  const container = makeContainer(env)
  const app = await makeServer({ env, container, authServices: services })
  const documents = new InMemoryLegalDocumentsRepository(vRows())
  const acceptances = new InMemoryLegalAcceptanceRepository(documents)
  let clock = C
  app.legalOverrides = { repo: documents, acceptances, now: () => clock }
  current = {
    app,
    container,
    services,
    stores,
    acceptances,
    setClock(at) {
      clock = at
    },
  }
  return current
}

let people = 0

async function person(h: Harness, role: "citizen" | "operator" = "citizen"): Promise<Person> {
  people += 1
  const email = role === "operator" ? OPERATOR_EMAIL : `neighbor${people}@example.org`
  const user = await h.stores.users.create(email, {
    displayName: role,
    role,
    emailVerified: true,
  })
  const token = await h.services.sessions.createSession(user.id, [role])
  // The accounts a case counts are its citizens; the operator reading the counts is not one of them.
  if (role === "citizen") h.acceptances.accounts.set(user.id, null)
  return { userId: user.id, token, csrfToken: await h.container.csrf.tokenForSession(token) }
}

function cookieHeaders(p: Person): Record<string, string> {
  return { cookie: `civfix_session=${p.token}`, "x-csrf-token": p.csrfToken }
}

function getStatus(h: Harness, p: Person): Promise<LightMyRequestResponse> {
  return h.app.inject({ method: "GET", url: "/v1/me/legal", headers: cookieHeaders(p) })
}

function accept(h: Harness, p: Person, payload: unknown): Promise<LightMyRequestResponse> {
  return h.app.inject({
    method: "POST",
    url: "/v1/me/legal/accept",
    headers: cookieHeaders(p),
    payload: payload as Record<string, unknown>,
  })
}

/** Rec(x, action, at): a consent record of `p`, surface `prompt` unless said. */
function rec(
  h: Harness,
  p: Person,
  key: string,
  action: "accepted" | "acknowledged",
  at: Date = new Date(C.getTime() - 10 * DAY_MS),
  surface: StoredConsentRecord["surface"] = "prompt",
): void {
  const [type, version] = key.split("@") as [LegalDocumentType, string]
  h.acceptances.records.push({
    userId: p.userId,
    type,
    version,
    sha256: sha(key),
    action,
    surface,
    acceptedAt: at,
  })
}

function rowsOf(h: Harness, p: Person): StoredConsentRecord[] {
  return h.acceptances.records.filter((r) => r.userId === p.userId)
}

interface Status {
  required: Record<string, unknown>[]
  notices: Record<string, unknown>[]
  accepted: Partial<Record<LegalDocumentType, { version: string; action: string; at: string }>>
}

function expectOutdated(res: LightMyRequestResponse, types: readonly LegalDocumentType[]): void {
  expect(res.statusCode).toBe(409)
  const body = res.json<{ code: string; details: unknown }>()
  expect(body.code).toBe("CONFLICT")
  expect(body.details).toEqual(outdatedDetails(types))
  expect(LegalVersionOutdatedDetailsSchema.safeParse(body.details).success).toBe(true)
}

const T1_STATUS = {
  required: [meta(CUR.terms), meta(CUR.privacy)],
  notices: [meta(CUR.cookies), meta(CUR.subprocessors)],
  accepted: {},
}

const SIGNUP_BODY = {
  items: [
    item(CUR.terms, "accepted"),
    item(CUR.privacy, "accepted"),
    item(CUR.cookies, "acknowledged"),
    item(CUR.subprocessors, "acknowledged"),
  ],
  surface: "signup",
}

const T14_BODY = {
  items: [item(CUR.terms, "accepted"), item(CUR.cookies, "acknowledged")],
}

describe("GET /me/legal", () => {
  it("T1: a person with no records owes the current Terms and Privacy", async () => {
    const h = await harness()
    const u = await person(h)
    const res = await getStatus(h, u)

    expect(res.statusCode).toBe(200)
    expect(MyLegalStatusResponseSchema.safeParse(res.json()).success).toBe(true)
    expect(res.json()).toEqual(T1_STATUS)
  })

  it("T2: a material version newer than the accepted one makes Terms required", async () => {
    const h = await harness()
    const u = await person(h)
    const at = new Date(C.getTime() - 30 * DAY_MS)
    rec(h, u, "terms@2026-10-26", "accepted", at)
    rec(h, u, "privacy@2026-10-26", "accepted", at)
    const body = (await getStatus(h, u)).json<Status>()

    expect(body.required).toEqual([meta(CUR.terms)])
    expect(body.notices).toEqual([meta(CUR.cookies), meta(CUR.subprocessors)])
    expect(body.accepted.terms).toEqual({
      version: "2026-10-26",
      action: "accepted",
      at: at.toISOString(),
    })
  })

  it("T3: pre-§66 acceptances owe the material Terms and notice the minor Privacy", async () => {
    const h = await harness()
    const u = await person(h)
    rec(h, u, "terms@2026-09-21", "accepted")
    rec(h, u, "privacy@2026-09-21", "accepted")
    const body = (await getStatus(h, u)).json<Status>()

    expect(body.required).toEqual([meta(CUR.terms)])
    expect(body.notices).toEqual([meta(CUR.privacy), meta(CUR.cookies), meta(CUR.subprocessors)])
  })

  it("T4: an acknowledgement never clears a required document", async () => {
    const h = await harness()
    const u = await person(h)
    const ackAt = new Date(C.getTime() - DAY_MS)
    rec(h, u, "terms@2026-10-26", "accepted", new Date(C.getTime() - 30 * DAY_MS))
    rec(h, u, "terms@2026-11-09", "acknowledged", ackAt)
    rec(h, u, "privacy@2026-10-26", "accepted")
    const body = (await getStatus(h, u)).json<Status>()

    expect(body.required).toEqual([meta(CUR.terms)])
    expect(body.notices.some((d) => d.type === "terms")).toBe(false)
    expect(body.accepted.terms).toEqual({
      version: "2026-11-09",
      action: "acknowledged",
      at: ackAt.toISOString(),
    })
  })

  it("T5: a minor change after the accepted version is a notice only", async () => {
    const h = await harness()
    const u = await person(h)
    rec(h, u, "terms@2026-11-02", "accepted")
    rec(h, u, "privacy@2026-10-26", "accepted")
    rec(h, u, "cookies@2026-10-26", "acknowledged")
    rec(h, u, "subprocessors@2026-10-26", "acknowledged")
    const body = (await getStatus(h, u)).json<Status>()

    expect(body.required).toEqual([])
    expect(body.notices).toEqual([meta(CUR.terms)])
  })

  it("T6: nothing is owed once the notice is acknowledged", async () => {
    const h = await harness()
    const u = await person(h)
    rec(h, u, "terms@2026-11-02", "accepted")
    rec(h, u, "privacy@2026-10-26", "accepted")
    rec(h, u, "cookies@2026-10-26", "acknowledged")
    rec(h, u, "subprocessors@2026-10-26", "acknowledged")
    rec(h, u, "terms@2026-11-09", "acknowledged")
    const body = (await getStatus(h, u)).json<Status>()

    expect(body.required).toEqual([])
    expect(body.notices).toEqual([])
    expect(Object.keys(body.accepted).sort()).toEqual(
      ["cookies", "privacy", "subprocessors", "terms"].sort(),
    )
    expect(body.accepted.terms).toMatchObject({ version: "2026-11-09", action: "acknowledged" })
    expect(body.accepted.privacy).toMatchObject({ version: "2026-10-26", action: "accepted" })
    expect(body.accepted.cookies).toMatchObject({ version: "2026-10-26", action: "acknowledged" })
    expect(body.accepted.subprocessors).toMatchObject({
      version: "2026-10-26",
      action: "acknowledged",
    })
  })

  it("T7: a version not yet in effect is owed only once it is", async () => {
    const h = await harness()
    const u = await person(h)
    rec(h, u, "terms@2026-11-09", "accepted")
    rec(h, u, "privacy@2026-10-26", "accepted")
    const before = (await getStatus(h, u)).json<Status>()

    expect([...before.required, ...before.notices].some((d) => d.type === "privacy")).toBe(false)

    h.setClock(new Date("2026-12-16T00:00:00.000Z"))
    const after = (await getStatus(h, u)).json<Status>()
    expect(after.required).toEqual([meta("privacy@2026-12-15")])
  })

  it("T8: only the person's own records count", async () => {
    const h = await harness()
    const u = await person(h)
    const u2 = await person(h)
    for (const key of Object.values(CUR)) rec(h, u2, key, "accepted")

    expect((await getStatus(h, u)).json()).toEqual(T1_STATUS)
  })

  it("T9: an older version recorded later does not undo the newer acceptance", async () => {
    const h = await harness()
    const u = await person(h)
    rec(h, u, "terms@2026-11-09", "accepted", new Date(C.getTime() - 2 * DAY_MS))
    rec(h, u, "terms@2026-11-02", "accepted", new Date(C.getTime() - DAY_MS), "event_registration")
    rec(h, u, "privacy@2026-10-26", "accepted")
    const body = (await getStatus(h, u)).json<Status>()

    expect(body.required).toEqual([])
    expect(body.notices.some((d) => d.type === "terms")).toBe(false)
    expect(body.accepted.terms?.version).toBe("2026-11-09")
  })

  it("T10: no session is UNAUTHORIZED", async () => {
    const h = await harness()
    const res = await h.app.inject({ method: "GET", url: "/v1/me/legal" })

    expect(res.statusCode).toBe(401)
    expect(res.json<{ code: string }>().code).toBe("UNAUTHORIZED")
  })
})

describe("POST /me/legal/accept", () => {
  it("T11: sign-up records the four documents with the server's time", async () => {
    const h = await harness()
    const u = await person(h)
    const res = await accept(h, u, SIGNUP_BODY)

    expect(res.statusCode).toBe(200)
    const body = AcceptLegalResponseSchema.parse(res.json())
    expect(body.required).toEqual([])
    expect(body.notices).toEqual([])
    const at = C.toISOString()
    expect(body.accepted).toEqual({
      terms: { version: "2026-11-09", action: "accepted", at },
      privacy: { version: "2026-10-26", action: "accepted", at },
      cookies: { version: "2026-10-26", action: "acknowledged", at },
      subprocessors: { version: "2026-10-26", action: "acknowledged", at },
    })
    expect(rowsOf(h, u)).toEqual(
      SIGNUP_BODY.items.map((i) => ({
        userId: u.userId,
        type: i.type,
        version: i.version,
        sha256: sha(`${i.type}@${i.version}`),
        action: i.action,
        surface: "signup",
        acceptedAt: C,
      })),
    )
  })

  it("T12: sign-up is refused once the account has records", async () => {
    const h = await harness()
    const u = await person(h)
    await accept(h, u, SIGNUP_BODY)
    const res = await accept(h, u, SIGNUP_BODY)

    expect(res.statusCode).toBe(422)
    const body = res.json<{ code: string; fields: Record<string, string> }>()
    expect(body.code).toBe("VALIDATION")
    expect(body.fields.surface).toEqual(expect.any(String))
    expect(rowsOf(h, u)).toHaveLength(4)
  })

  it("T13: sign-up is refused after an event registration's record", async () => {
    const h = await harness()
    const u = await person(h)
    rec(h, u, CUR.terms, "accepted", new Date(C.getTime() - DAY_MS), "event_registration")
    const res = await accept(h, u, SIGNUP_BODY)

    expect(res.statusCode).toBe(422)
    const body = res.json<{ code: string; fields: Record<string, string> }>()
    expect(body.code).toBe("VALIDATION")
    expect(body.fields.surface).toEqual(expect.any(String))
    expect(rowsOf(h, u)).toHaveLength(1)
  })

  it("T14: the surface defaults to prompt for accepted and notice for acknowledged", async () => {
    const h = await harness()
    const u = await person(h)
    const res = await accept(h, u, T14_BODY)

    expect(res.statusCode).toBe(200)
    expect(rowsOf(h, u).map((r) => [r.type, r.surface])).toEqual([
      ["terms", "prompt"],
      ["cookies", "notice"],
    ])
    const body = res.json<Status>()
    expect(body.required).toEqual([meta(CUR.privacy)])
    expect(body.notices).toEqual([meta(CUR.subprocessors)])
  })

  it("T15: a given surface applies to every item", async () => {
    const h = await harness()
    const u = await person(h)
    const res = await accept(h, u, { ...T14_BODY, surface: "prompt" })

    expect(res.statusCode).toBe(200)
    expect(rowsOf(h, u).map((r) => r.surface)).toEqual(["prompt", "prompt"])
  })

  it("T16: a sha256 that is not the current version's is outdated and writes nothing", async () => {
    const h = await harness()
    const u = await person(h)
    const res = await accept(h, u, {
      items: [
        { type: "terms", version: "2026-11-09", sha256: sha("other"), action: "accepted" },
        item(CUR.privacy, "accepted"),
      ],
    })

    expectOutdated(res, ["terms", "privacy"])
    expect(rowsOf(h, u)).toEqual([])
  })

  it.each([
    ["an earlier version", item("terms@2026-11-02", "accepted"), ["terms"]],
    ["a version not yet in effect", item("privacy@2026-12-15", "accepted"), ["privacy"]],
    [
      "no such version",
      {
        type: "terms",
        version: "2026-01-01",
        sha256: sha("terms@2026-01-01"),
        action: "accepted",
      },
      ["terms"],
    ],
  ] as const)("T17: %s is outdated and writes nothing", async (_name, claimed, types) => {
    const h = await harness()
    const u = await person(h)
    const res = await accept(h, u, { items: [claimed] })

    expectOutdated(res, types)
    expect(rowsOf(h, u)).toEqual([])
  })

  it("T18: acknowledging a required document is refused and writes nothing", async () => {
    const h = await harness()
    const u = await person(h)
    const res = await accept(h, u, {
      items: [item(CUR.privacy, "accepted"), item(CUR.terms, "acknowledged")],
    })

    expect(res.statusCode).toBe(422)
    const body = res.json<{ code: string; fields: Record<string, string> }>()
    expect(body.code).toBe("VALIDATION")
    expect(body.fields["items.1.action"]).toEqual(expect.any(String))
    expect(rowsOf(h, u)).toEqual([])
  })

  it("T19: acknowledging a notice records it", async () => {
    const h = await harness()
    const u = await person(h)
    rec(h, u, "terms@2026-11-02", "accepted")
    rec(h, u, "privacy@2026-10-26", "accepted")
    const res = await accept(h, u, { items: [item(CUR.terms, "acknowledged")] })

    expect(res.statusCode).toBe(200)
    const fresh = rowsOf(h, u).slice(2)
    expect(fresh.map((r) => [r.action, r.surface])).toEqual([["acknowledged", "notice"]])
    const body = res.json<Status>()
    expect(body.notices.some((d) => d.type === "terms")).toBe(false)
    expect(body.accepted.terms).toEqual({
      version: "2026-11-09",
      action: "acknowledged",
      at: C.toISOString(),
    })
  })

  it("T20: accepting a recorded version again changes nothing", async () => {
    const h = await harness()
    const u = await person(h)
    await accept(h, u, SIGNUP_BODY)
    const signedUpAt = C.toISOString()
    h.setClock(new Date(C.getTime() + 60_000))
    const res = await accept(h, u, { items: [item(CUR.terms, "accepted")] })

    expect(res.statusCode).toBe(200)
    expect(rowsOf(h, u)).toHaveLength(4)
    expect(res.json<Status>().accepted.terms?.at).toBe(signedUpAt)
    expect(res.json()).toEqual((await getStatus(h, u)).json())
  })

  it("T21: accepting a version only acknowledged records the acceptance", async () => {
    const h = await harness()
    const u = await person(h)
    rec(h, u, "terms@2026-11-02", "accepted")
    rec(h, u, "privacy@2026-10-26", "accepted")
    await accept(h, u, { items: [item(CUR.terms, "acknowledged")] })
    const res = await accept(h, u, { items: [item(CUR.terms, "accepted")] })

    expect(res.statusCode).toBe(200)
    const fresh = rowsOf(h, u).slice(3)
    expect(fresh.map((r) => [r.action, r.surface])).toEqual([["accepted", "prompt"]])
    expect(res.json<Status>().accepted.terms?.action).toBe("accepted")
  })

  it.each([
    ["no items", { items: [] }],
    [
      "five items",
      {
        items: [...SIGNUP_BODY.items, item("terms@2026-11-02", "accepted")],
      },
    ],
    ["two terms items", { items: [item(CUR.terms, "accepted"), item(CUR.terms, "accepted")] }],
    ["an item with an extra key", { items: [{ ...item(CUR.terms, "accepted"), note: "x" }] }],
    ["an event_registration surface", { ...T14_BODY, surface: "event_registration" }],
    ["an extra top-level key", { ...T14_BODY, extra: true }],
  ])("T22: %s is a validation error and writes nothing", async (_name, payload) => {
    const h = await harness()
    const u = await person(h)
    const res = await accept(h, u, payload)

    expect(res.statusCode).toBe(422)
    expect(res.json<{ code: string }>().code).toBe("VALIDATION")
    expect(rowsOf(h, u)).toEqual([])
  })

  it("T23: needs a session, and a cookie session needs its CSRF token", async () => {
    const h = await harness()
    const u = await person(h)
    const url = "/v1/me/legal/accept"

    const anonymous = await h.app.inject({ method: "POST", url, payload: T14_BODY })
    expect(anonymous.statusCode).toBe(401)
    expect(anonymous.json<{ code: string }>().code).toBe("UNAUTHORIZED")

    const noCsrf = await h.app.inject({
      method: "POST",
      url,
      headers: { cookie: `civfix_session=${u.token}` },
      payload: T14_BODY,
    })
    expect(noCsrf.statusCode).toBe(403)
    expect(noCsrf.json<{ code: string }>().code).toBe("FORBIDDEN")

    const bearer = await h.app.inject({
      method: "POST",
      url,
      headers: { authorization: `Bearer ${u.token}` },
      payload: T14_BODY,
    })
    expect(bearer.statusCode).toBe(200)
  })

  it("T24: 20 requests a minute per person", async () => {
    const h = await harness()
    const u = await person(h)
    const u2 = await person(h)
    for (let i = 0; i < 20; i++) {
      const ok = await accept(h, u, T14_BODY)
      expect(ok.statusCode, `request ${i + 1}`).toBe(200)
    }
    const limited = await accept(h, u, T14_BODY)
    expect(limited.statusCode).toBe(429)
    expect(limited.json<{ code: string }>().code).toBe("RATE_LIMITED")

    expect((await accept(h, u2, T14_BODY)).statusCode).toBe(200)
  })
})

describe("GET /admin/legal/versions counts", () => {
  async function adminVersions(h: Harness): Promise<Record<string, unknown>[]> {
    const operator = await person(h, "operator")
    const res = await h.app.inject({
      method: "GET",
      url: "/v1/admin/legal/versions",
      headers: { authorization: `Bearer ${operator.token}` },
    })
    expect(res.statusCode).toBe(200)
    return res.json<{ documents: Record<string, unknown>[] }>().documents
  }

  function entry(documents: Record<string, unknown>[], key: string): Record<string, unknown> {
    const found = documents.find((d) => `${String(d.type)}@${String(d.version)}` === key)
    if (found === undefined) throw new Error(`no entry ${key}`)
    return found
  }

  async function accounts(h: Harness, n: number): Promise<Person[]> {
    const out: Person[] = []
    for (let i = 0; i < n; i++) out.push(await person(h))
    return out
  }

  it("T45: counts distinct active accounts that accepted each current Terms and Privacy", async () => {
    const h = await harness()
    const [a, b, c, d] = (await accounts(h, 5)) as [Person, Person, Person, Person, Person]
    const x = await person(h)
    h.acceptances.accounts.set(x.userId, new Date(C.getTime() - DAY_MS))
    rec(h, a, CUR.terms, "accepted")
    rec(h, a, CUR.terms, "accepted", C, "event_registration")
    rec(h, b, CUR.terms, "accepted")
    rec(h, x, CUR.terms, "accepted")
    rec(h, c, CUR.terms, "acknowledged")
    rec(h, a, CUR.privacy, "accepted")
    rec(h, d, "terms@2026-11-02", "accepted")

    const documents = await adminVersions(h)
    expect(entry(documents, CUR.terms)).toMatchObject({ acceptedCount: 2, activeAccounts: 5 })
    expect(entry(documents, CUR.privacy)).toMatchObject({ acceptedCount: 1, activeAccounts: 5 })
    for (const document of documents) {
      const key = `${String(document.type)}@${String(document.version)}`
      const counted = key === CUR.terms || key === CUR.privacy
      expect("acceptedCount" in document, key).toBe(counted)
      expect("activeAccounts" in document, key).toBe(counted)
    }
    const { acceptedCount: _count, activeAccounts: _active, ...terms } = entry(documents, CUR.terms)
    expect(terms).toEqual(meta(CUR.terms))
  })

  it("T46: no records count zero of the active accounts", async () => {
    const h = await harness()
    await accounts(h, 5)

    const documents = await adminVersions(h)
    expect(entry(documents, CUR.terms)).toMatchObject({ acceptedCount: 0, activeAccounts: 5 })
    expect(entry(documents, CUR.privacy)).toMatchObject({ acceptedCount: 0, activeAccounts: 5 })
  })
})
