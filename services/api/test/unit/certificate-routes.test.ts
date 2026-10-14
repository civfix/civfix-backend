/**
 * THE HIGHEST-VALUE TEST IN THIS FILE is `presignGet(key, 900, { forceSigned: true })`. `FakeStorage`
 * declares `presignGet(key, _ttlSec)` and always returns `memory://<key>`, so asserting on the returned
 * STRING proves nothing about the third argument, and in production `R2_PUBLIC_BASE` is set, so a
 * missing `forceSigned` makes `R2Storage.presignGet` hand back an UNSIGNED, PERMANENT CDN URL. That
 * would publish every volunteer's itemised service record forever, with no expiry and no revocation.
 * A thin recording wrapper is therefore injected and its ARGUMENTS are asserted.
 *
 * The other rules pinned here: an empty ledger is a 409 (no empty official-looking documents), a repeat
 * tap reuses one document rather than minting a second, an edited ledger row mints a genuinely new one,
 * revoking someone else's code is a 404 (never a 403: no existence oracle), and the PUBLIC verification
 * projection leaks no url / userId / r2Key.
 */

import { afterEach, describe, expect, it } from "vitest"
import type { FastifyInstance } from "fastify"
import { randomUUID } from "node:crypto"
import { CERTIFICATE_CODE_RE, formatCertificateCode } from "@civfix/shared"
import { FakeMailer, FakeStorage } from "@civfix/shared/fakes"
import type { StorageHead, StoragePutMeta } from "@civfix/shared/interfaces"
import { makeServer } from "../../src/server.js"
import { makeContainer } from "../../src/di.js"
import { loadEnv } from "../../src/env.js"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { makeInMemoryStores } from "../../src/auth/stores.js"
import { makeAuthServices } from "../../src/auth/auth-services.js"
import { StubJwksVerifier } from "../helpers/auth.js"
import { InMemoryVolunteerHoursRepository } from "../helpers/volunteer-hours-repository.memory.js"
import { InMemoryCertificateRepository } from "../helpers/certificate-repository.memory.js"
import {
  makeCertificateService,
  type CertificateStorage,
} from "../../src/services/certificate-service.js"

const GEOID = "0644000"

/** Every presign the service issued, arguments and all. */
interface PresignCall {
  key: string
  ttlSec: number
  opts: { forceSigned?: boolean } | undefined
}

/**
 * A `CertificateStorage` that records `presignGet`'s ARGUMENTS and delegates everything else to a real
 * `FakeStorage`. Deliberately NOT a subclass: the point is to observe the exact call the service makes
 * through the structural seam it declares, third parameter included.
 */
class RecordingStorage implements CertificateStorage {
  readonly presigns: PresignCall[] = []
  constructor(readonly inner: FakeStorage) {}

  presignGet(key: string, ttlSec: number, opts?: { forceSigned?: boolean }): Promise<string> {
    this.presigns.push({ key, ttlSec, opts })
    return this.inner.presignGet(key, ttlSec)
  }
  head(key: string): Promise<StorageHead | null> {
    return this.inner.head(key)
  }
  put(key: string, body: Uint8Array, meta?: StoragePutMeta): Promise<void> {
    return this.inner.put(key, body, meta)
  }
  delete(key: string): Promise<void> {
    return this.inner.delete(key)
  }
}

interface Session {
  userId: string
  token: string
}

interface WebSession {
  userId: string
  cookie: string
  csrfToken: string
}

interface Harness {
  app: FastifyInstance
  certs: InMemoryCertificateRepository
  hours: InMemoryVolunteerHoursRepository
  storage: RecordingStorage
  objects: FakeStorage
  signIn(email: string, name: string): Promise<Session>
  signInWeb(email: string, name: string): Promise<WebSession>
  /** Credit `hours` to `userId` for a fresh event, so the ledger is non-empty. */
  credit(userId: string, hours: number, title?: string): string
}

let current: Harness | undefined

afterEach(async () => {
  if (current) {
    await current.app.close()
    current = undefined
  }
})

async function makeHarness(): Promise<Harness> {
  const env = loadEnv({ NODE_ENV: "test" })
  const stores = makeInMemoryStores()
  const mailer = new FakeMailer()
  const authServices = makeAuthServices({
    stores,
    cache: new InMemoryCacheClient(() => Date.now()),
    mailer,
    oauthConfig: {},
    verifier: new StubJwksVerifier(),
    now: () => Date.now(),
  })

  const certs = new InMemoryCertificateRepository()
  const hours = new InMemoryVolunteerHoursRepository()
  hours.seedJurisdiction(GEOID, "Los Angeles")
  const objects = new FakeStorage()
  const storage = new RecordingStorage(objects)

  const container = makeContainer(env)
  const app = await makeServer({
    env,
    container,
    authServices,
    certificateOverrides: { repo: certs, hours, storage },
  })

  async function verify(email: string, name: string, client: "mobile" | "web") {
    const requested = await app.inject({
      method: "POST",
      url: "/v1/auth/otp/request",
      payload: { email },
    })
    expect(requested.statusCode).toBe(200)
    const code = mailer.lastOtpFor(email)!
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/otp/verify",
      headers: { "x-client": client },
      payload: { email, code },
    })
    expect(res.statusCode).toBe(200)
    const userId = res.json().user.id as string
    // The routes read holder identity through the certificate repo (users).
    certs.setHolder(userId, { displayName: name, handle: name.toLowerCase() })
    return { res, userId }
  }

  const h: Harness = {
    app,
    certs,
    hours,
    storage,
    objects,
    async signIn(email, name) {
      const { res, userId } = await verify(email, name, "mobile")
      return { userId, token: res.json().token as string }
    },
    async signInWeb(email, name) {
      const { res, userId } = await verify(email, name, "web")
      const setCookie = res.headers["set-cookie"]
      const lines = Array.isArray(setCookie) ? setCookie : [String(setCookie)]
      const cookie = lines.find((l) => l.startsWith("civfix_session="))!.split(";")[0]!
      return { userId, cookie, csrfToken: res.json().csrfToken as string }
    },
    credit(userId, amount, title = "Beach cleanup at the pier") {
      const cleanupId = randomUUID()
      const host = "00000000-0000-4000-8000-0000000000aa"
      hours.seedUser(host, { name: "Ada Host", handle: "ada", avatarUrl: null })
      hours.seedCleanup(cleanupId, {
        title,
        referenceCode: "CFX-EVT-1",
        scheduledAt: new Date("2026-03-04T18:00:00.000Z"),
      })
      void hours.logEventHours({
        actorId: host,
        cleanupId,
        geoid: GEOID,
        entries: [{ userId, hours: amount }],
      })
      return cleanupId
    },
  }
  current = h
  return h
}

function bearer(s: Session): Record<string, string> {
  return { authorization: `Bearer ${s.token}`, "x-client": "mobile" }
}

function issue(app: FastifyInstance, s: Session) {
  return app.inject({
    method: "POST",
    url: "/v1/me/volunteer-hours/certificates",
    headers: bearer(s),
    payload: {},
  })
}

describe("POST /me/volunteer-hours/certificates", () => {
  it("401s an unauthenticated request", async () => {
    const h = await makeHarness()
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/me/volunteer-hours/certificates",
      payload: {},
    })
    expect(res.statusCode).toBe(401)
  })

  it("409s when the ledger is empty (no empty official-looking documents)", async () => {
    const h = await makeHarness()
    const me = await h.signIn("empty@example.com", "Empty")
    const res = await issue(h.app, me)
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe("CONFLICT")
    expect(h.objects.objects.size).toBe(0)
  })

  it("stores ONE pdf at the C16 key with the pdf content type and the inline disposition", async () => {
    const h = await makeHarness()
    const me = await h.signIn("happy@example.com", "Jane Doe")
    h.credit(me.userId, 4.5)

    const res = await issue(h.app, me)
    expect(res.statusCode).toBe(200)
    const body = res.json<{
      certificate: { code: string; url: string | null; status: string; totalHours: number }
      reused?: boolean
    }>()
    expect(body.certificate.code).toMatch(CERTIFICATE_CODE_RE)
    expect(body.certificate.status).toBe("valid")
    expect(body.certificate.totalHours).toBe(4.5)
    expect(body.certificate.url).toBeTruthy()
    expect(body.reused).toBe(false)

    expect(h.objects.objects.size).toBe(1)
    const key = [...h.objects.objects.keys()][0]!
    expect(key).toMatch(/^certificates\/service-hours\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.pdf$/)

    const head = await h.objects.head(key)
    expect(head?.contentType).toBe("application/pdf")
    expect(head?.contentDisposition).toBe(
      `inline; filename="civfix-service-hours-${formatCertificateCode(body.certificate.code)}.pdf"`,
    )
    expect(Buffer.from(h.objects.get(key)!).subarray(0, 5).toString()).toBe("%PDF-")
  })

  it("presigns with forceSigned: true and the 900s certificate TTL (H9)", async () => {
    const h = await makeHarness()
    const me = await h.signIn("presign@example.com", "Presign")
    h.credit(me.userId, 2)

    const res = await issue(h.app, me)
    expect(res.statusCode).toBe(200)

    const key = [...h.objects.objects.keys()][0]!
    expect(h.storage.presigns).toHaveLength(1)
    // THE assertion: a public CDN URL here would be permanent and unrevocable.
    expect(h.storage.presigns[0]).toEqual({ key, ttlSec: 900, opts: { forceSigned: true } })
  })

  it("a second tap over an UNCHANGED ledger returns the same code, one object, reused: true", async () => {
    const h = await makeHarness()
    const me = await h.signIn("twice@example.com", "Twice")
    h.credit(me.userId, 3)

    const first = await issue(h.app, me)
    const second = await issue(h.app, me)
    expect(first.statusCode).toBe(200)
    expect(second.statusCode).toBe(200)
    expect(second.json().certificate.code).toBe(first.json().certificate.code)
    expect(second.json().reused).toBe(true)
    expect(h.objects.objects.size).toBe(1)
    expect(h.certs.all()).toHaveLength(1)
    // The reuse path still mints a fresh URL; that is the whole point of calling again.
    expect(second.json().certificate.url).toBeTruthy()
    expect(h.storage.presigns).toHaveLength(2)
  })

  it("an EDITED ledger row mints a different code and a second object", async () => {
    const h = await makeHarness()
    const me = await h.signIn("edited@example.com", "Edited")
    const cleanupId = h.credit(me.userId, 3)

    const first = await issue(h.app, me)
    expect(first.statusCode).toBe(200)

    // The host corrects the credit. `volunteer_hours.id` survives the upsert, so the row identity is
    // stable and only `hours` moves, which is exactly what the fingerprint keys on.
    await h.hours.logEventHours({
      actorId: "00000000-0000-4000-8000-0000000000aa",
      cleanupId,
      geoid: GEOID,
      entries: [{ userId: me.userId, hours: 6 }],
    })

    const second = await issue(h.app, me)
    expect(second.statusCode).toBe(200)
    expect(second.json().certificate.code).not.toBe(first.json().certificate.code)
    expect(second.json().reused).toBe(false)
    expect(h.objects.objects.size).toBe(2)
    // The OLD document stays valid: it remains a true statement about a point in time.
    expect(h.certs.all()).toHaveLength(2)
  })

  it("403s a cookie-session issue with no X-CSRF-Token, and accepts it once echoed", async () => {
    const h = await makeHarness()
    const me = await h.signInWeb("csrf@example.com", "Csrf")
    h.credit(me.userId, 1.5)

    const bare = await h.app.inject({
      method: "POST",
      url: "/v1/me/volunteer-hours/certificates",
      headers: { cookie: me.cookie },
      payload: {},
    })
    expect(bare.statusCode).toBe(403)
    expect(bare.json().message).toMatch(/CSRF/i)

    const ok = await h.app.inject({
      method: "POST",
      url: "/v1/me/volunteer-hours/certificates",
      headers: { cookie: me.cookie, "x-csrf-token": me.csrfToken },
      payload: {},
    })
    expect(ok.statusCode).toBe(200)
  })
})

describe("GET /me/volunteer-hours/certificates", () => {
  it("lists the holder's own documents and never presigns on a list read", async () => {
    const h = await makeHarness()
    const me = await h.signIn("list@example.com", "Lister")
    h.credit(me.userId, 2)
    await issue(h.app, me)
    const presignsAfterIssue = h.storage.presigns.length

    const res = await h.app.inject({
      method: "GET",
      url: "/v1/me/volunteer-hours/certificates",
      headers: bearer(me),
    })
    expect(res.statusCode).toBe(200)
    const list = res.json<{ certificates: { code: string; url: string | null }[] }>()
    expect(list.certificates).toHaveLength(1)
    expect(list.certificates[0]!.url).toBeNull()
    expect(h.storage.presigns).toHaveLength(presignsAfterIssue)
  })

  it("401s an unauthenticated request", async () => {
    const h = await makeHarness()
    const res = await h.app.inject({ method: "GET", url: "/v1/me/volunteer-hours/certificates" })
    expect(res.statusCode).toBe(401)
  })
})

describe("POST /me/volunteer-hours/certificates/:code/revoke", () => {
  it("revokes, deletes the object, and leaves the code answering 'revoked'", async () => {
    const h = await makeHarness()
    const me = await h.signIn("revoke@example.com", "Revoker")
    h.credit(me.userId, 5)
    const issued = await issue(h.app, me)
    const code = issued.json().certificate.code as string
    expect(h.objects.objects.size).toBe(1)

    const res = await h.app.inject({
      method: "POST",
      url: `/v1/me/volunteer-hours/certificates/${code}/revoke`,
      headers: bearer(me),
      payload: {},
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().certificate.status).toBe("revoked")
    expect(res.json().certificate.url).toBeNull()
    expect(h.objects.objects.size).toBe(0)
  })

  it("frees the fingerprint slot so the same ledger can be re-issued with a NEW code", async () => {
    const h = await makeHarness()
    const me = await h.signIn("reissue@example.com", "Reissuer")
    h.credit(me.userId, 5)
    const first = await issue(h.app, me)
    const code = first.json().certificate.code as string

    await h.app.inject({
      method: "POST",
      url: `/v1/me/volunteer-hours/certificates/${code}/revoke`,
      headers: bearer(me),
      payload: {},
    })

    const second = await issue(h.app, me)
    expect(second.statusCode).toBe(200)
    expect(second.json().certificate.code).not.toBe(code)
    expect(second.json().reused).toBe(false)
  })

  it("404s (NOT 403) when the code belongs to somebody else: no existence oracle", async () => {
    const h = await makeHarness()
    const owner = await h.signIn("owner@example.com", "Owner")
    const stranger = await h.signIn("stranger@example.com", "Stranger")
    h.credit(owner.userId, 2)
    const issued = await issue(h.app, owner)
    const code = issued.json().certificate.code as string

    const res = await h.app.inject({
      method: "POST",
      url: `/v1/me/volunteer-hours/certificates/${code}/revoke`,
      headers: bearer(stranger),
      payload: {},
    })
    expect(res.statusCode).toBe(404)
    expect(h.objects.objects.size).toBe(1)
  })
})

/**
 * Two branches the HTTP surface cannot reach, driven through `makeCertificateService` directly. Both are
 * "approximately never" paths that would 500 in production if they were wrong, and neither has a route
 * seam for injecting the failure.
 */
describe("certificate service: recovery branches", () => {
  it("re-renders in place when a LIVE row's object has vanished (operator error, DP §4.4)", async () => {
    const h = await makeHarness()
    const me = await h.signIn("regen@example.com", "Regen")
    h.credit(me.userId, 3)

    const first = await issue(h.app, me)
    expect(first.statusCode).toBe(200)
    const code = first.json().certificate.code as string
    const key = [...h.objects.objects.keys()][0]!
    const originalSha = first.json().certificate.documentSha256 as string

    // The bucket loses the object while the row survives.
    await h.objects.delete(key)
    expect(h.objects.objects.size).toBe(0)

    const second = await issue(h.app, me)
    expect(second.statusCode).toBe(200)
    // SAME document: same code, same key, no second row. A re-render, not a re-issue.
    expect(second.json().certificate.code).toBe(code)
    expect(second.json().reused).toBe(true)
    expect([...h.objects.objects.keys()]).toEqual([key])
    expect(h.certs.all()).toHaveLength(1)
    // The stored hash was refreshed to describe the bytes that are actually there now.
    expect(second.json().certificate.documentSha256).toBe(originalSha)
    expect(h.certs.all()[0]!.regeneratedAt).not.toBeNull()
  })

  it("re-mints and RE-RENDERS on a code collision (the code is printed on the page)", async () => {
    const h = await makeHarness()
    const me = await h.signIn("collide@example.com", "Collide")
    h.credit(me.userId, 2)

    // Park a row that already owns the first code the minter will produce.
    const taken = "T0KENC0DE001"
    await h.certs.insert({
      id: randomUUID(),
      userId: randomUUID(),
      code: taken,
      locale: "en",
      holderName: "Someone Else",
      holderHandle: null,
      holderVerified: false,
      totalHours: 1,
      entryCount: 1,
      periodStart: null,
      periodEnd: null,
      ledgerFingerprint: "unrelated",
      snapshot: { v: 1 } as never,
      r2Key: "certificates/service-hours/2026/01/taken.pdf",
      documentSha256: "c".repeat(64),
      byteSize: 1,
      issuedAt: new Date("2026-01-01T00:00:00.000Z"),
    })

    const codes = [taken, "FRESHC0DE001"]
    let n = 0
    const service = makeCertificateService({
      repo: h.certs,
      hours: h.hours,
      storage: h.storage,
      mintCode: () => codes[Math.min(n++, codes.length - 1)]!,
    })

    const res = await service.issue(me.userId)
    expect(n).toBe(2) // the first draw lost and was redrawn
    expect(res.certificate.code).toBe("FRESHC0DE001")
    // The re-render overwrote the SAME key rather than orphaning the first attempt's object.
    const mine = h.certs.all().find((r) => r.code === "FRESHC0DE001")!
    expect([...h.objects.objects.keys()]).toContain(mine.r2Key)
    // The parked row's object was never written, and the losing draw reused the same key, so exactly
    // one object exists.
    expect(h.objects.objects.size).toBe(1)
  })
})

describe("GET /service-hours/verify/:code (public)", () => {
  /** Seed a row DIRECTLY so the code is deterministic (it carries both a 0 and a 1 to fold onto). */
  async function seedRow(
    h: Harness,
    over: { code?: string; revokedAt?: Date; revokedReason?: string; deleted?: boolean } = {},
  ): Promise<string> {
    const userId = randomUUID()
    h.certs.setHolder(userId, {
      displayName: "Jane Doe",
      handle: "jane",
      ...(over.deleted !== undefined ? { deleted: over.deleted } : {}),
    })
    const code = over.code ?? "A1B2C3D4E5F0"
    const id = randomUUID()
    await h.certs.insert({
      id,
      userId,
      code,
      locale: "en",
      holderName: "Jane Doe",
      holderHandle: "jane",
      holderVerified: true,
      totalHours: 12.5,
      entryCount: 4,
      periodStart: new Date("2026-01-02T00:00:00.000Z"),
      periodEnd: new Date("2026-03-04T00:00:00.000Z"),
      ledgerFingerprint: `fp-${id}`,
      snapshot: { v: 1 } as never,
      r2Key: `certificates/service-hours/2026/03/${id}.pdf`,
      documentSha256: "a".repeat(64),
      byteSize: 42000,
      issuedAt: new Date("2026-03-05T10:00:00.000Z"),
    })
    if (over.revokedAt) {
      await h.certs.revoke(userId, code, over.revokedReason ?? "holder", over.revokedAt)
    }
    return code
  }

  function verifyCode(h: Harness, code: string) {
    return h.app.inject({ method: "GET", url: `/v1/service-hours/verify/${code}` })
  }

  it("200s UNAUTHENTICATED and returns only what is printed on the document", async () => {
    const h = await makeHarness()
    const code = await seedRow(h)

    const res = await verifyCode(h, code)
    expect(res.statusCode).toBe(200)
    const body = res.json<Record<string, unknown>>()
    expect(body.status).toBe("valid")
    expect(body.holderName).toBe("Jane Doe")
    expect(body.totalHours).toBe(12.5)
    expect(body.entryCount).toBe(4)
    expect(body.documentSha256).toBe("a".repeat(64))

    // The capability must never become a download link, and must never disclose the holder's id.
    const keys = Object.keys(body)
    for (const forbidden of ["url", "userId", "r2Key", "snapshot", "rows", "entries", "id"]) {
      expect(keys, `verify must not expose ${forbidden}`).not.toContain(forbidden)
    }
  })

  it("reports a REVOKED code as revoked, keeping holderName and issuedAt", async () => {
    const h = await makeHarness()
    const code = await seedRow(h, {
      code: "B1C2D3E4F5G6",
      revokedAt: new Date("2026-04-01T00:00:00.000Z"),
    })

    const res = await verifyCode(h, code)
    expect(res.statusCode).toBe(200)
    const body = res.json<Record<string, unknown>>()
    expect(body.status).toBe("revoked")
    expect(body.revokedReason).toBe("holder")
    // The person holding the paper learns WHY it is not good.
    expect(body.holderName).toBe("Jane Doe")
    expect(body.issuedAt).toBe("2026-03-05T10:00:00.000Z")
  })

  it("reports a TOMBSTONED holder as account_closed with holderName omitted", async () => {
    const h = await makeHarness()
    const code = await seedRow(h, { code: "C1D2E3F4G5H6", deleted: true })

    const res = await verifyCode(h, code)
    expect(res.statusCode).toBe(200)
    const body = res.json<Record<string, unknown>>()
    expect(body.status).toBe("revoked")
    expect(body.revokedReason).toBe("account_closed")
    expect(Object.keys(body)).not.toContain("holderName")
  })

  it("404s a well-formed but unknown code, and 422s a malformed one", async () => {
    const h = await makeHarness()
    await seedRow(h)

    const unknown = await verifyCode(h, "ZZZZZZZZZZZZ")
    expect(unknown.statusCode).toBe(404)

    const malformed = await verifyCode(h, "nope")
    expect(malformed.statusCode).toBe(422)
    expect(malformed.json().code).toBe("VALIDATION")
  })

  it("normalizes the printed forms: lowercase + dashes, and the letter O for zero", async () => {
    const h = await makeHarness()
    const code = await seedRow(h) // A1B2C3D4E5F0
    const canonical = (await verifyCode(h, code)).json()

    // What a verifier actually types off the page.
    const dashed = await verifyCode(h, formatCertificateCode(code).toLowerCase())
    expect(dashed.statusCode).toBe(200)
    expect(dashed.json()).toEqual(canonical)

    // Crockford folding: O -> 0, I/L -> 1.
    const letterO = await verifyCode(h, "A1B2C3D4E5FO")
    expect(letterO.statusCode).toBe(200)
    expect(letterO.json()).toEqual(canonical)
  })

  it("resolves a valid code typed all-lowercase, undashed, or with I/L for one", async () => {
    const h = await makeHarness()
    const code = await seedRow(h, { code: "A1B2C3D4E5F1" })
    const canonical = (await verifyCode(h, code)).json()

    for (const typed of ["a1b2c3d4e5f1", "A1B2C3D4E5FI", "a1b2c3d4e5fl", "cfx-a1b2-c3d4-e5fi"]) {
      const res = await verifyCode(h, typed)
      expect(res.statusCode, `"${typed}" must resolve`).toBe(200)
      expect(res.json()).toEqual(canonical)
    }
  })

  it("still 422s a code outside the alphabet or the wrong length", async () => {
    const h = await makeHarness()
    await seedRow(h)

    for (const typed of ["A1B2C3D4E5F", "A1B2C3D4E5F0A", "A1B2-C3D4-E5F", "A1B2C3D4E5F$"]) {
      const res = await verifyCode(h, typed)
      expect(res.statusCode, `"${typed}" must be rejected`).toBe(422)
      expect(res.json().code).toBe("VALIDATION")
    }
  })
})
