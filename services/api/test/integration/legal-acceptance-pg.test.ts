/**
 * Legal acceptance (GET /me/legal, POST /me/legal/accept) and event consent's account records, through
 * the real Fastify app on PostGIS with the seeded and loaded `legal_documents` of the pinned contract.
 * The rules themselves are covered offline in test/unit/legal-acceptance-routes.test.ts and
 * test/unit/legal-service.test.ts; these cases prove the SQL: the foreign key, the per-person lock and the
 * registration transaction.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import type { FastifyInstance, LightMyRequestResponse } from "fastify"
import { FakeMailer } from "@civfix/seams"
import { endpoints, versionedPath } from "@civfix/contract/client"
import { legalDocument } from "@civfix/contract/legal"
import type { LegalDocumentType } from "@civfix/contract"
import { withPg, testHandle, type PgHarness } from "../helpers/pg.js"
import { seedCleanup } from "../helpers/cleanups.js"
import { makeServer } from "../../src/server.js"
import { makeContainer, type Container } from "../../src/di.js"
import { loadEnv } from "../../src/env.js"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { InMemoryCounterStore } from "../../src/abuse/counter-store.js"
import { PgAuthStores } from "../../src/auth/pg-stores.js"
import { makeAuthServices, type AuthServices } from "../../src/auth/auth-services.js"
import { makeDataExportService } from "../../src/services/data-export-service.js"
import { purgeDemo } from "../../src/db/seed-demo-la.js"
import { DEMO_EMAIL_DOMAIN } from "../../src/db/seed-demo-domain.js"

const pg = await withPg()

interface Person {
  userId: string
  cookie: string
  csrfToken: string
}

interface StoredRecord {
  document_type: string
  document_version: string
  document_sha256: string
  action: string
  surface: string
}

const TYPES: readonly LegalDocumentType[] = ["terms", "privacy", "cookies", "subprocessors"]

function currentItem(type: LegalDocumentType, action: "accepted" | "acknowledged") {
  const document = legalDocument(type)
  return { type, version: document.version, sha256: document.sha256, action }
}

const SIGNUP_BODY = {
  items: [
    currentItem("terms", "accepted"),
    currentItem("privacy", "accepted"),
    currentItem("cookies", "acknowledged"),
    currentItem("subprocessors", "acknowledged"),
  ],
  surface: "signup",
}

const T14_BODY = {
  items: [currentItem("terms", "accepted"), currentItem("cookies", "acknowledged")],
}

describe.skipIf(!pg)("legal acceptance (integration)", () => {
  let h: PgHarness
  let app: FastifyInstance
  let container: Container
  let authServices: AuthServices

  beforeAll(async () => {
    h = pg as PgHarness
    const env = loadEnv({ NODE_ENV: "test", DATABASE_URL: h.uri })
    container = makeContainer(env)
    authServices = makeAuthServices({
      stores: new PgAuthStores(container.getDb().db, {
        certificateObjects: container.storage,
        notifier: container.getNotificationService(),
        jobs: container.jobs,
      }),
      cache: new InMemoryCacheClient(),
      mailer: container.mailer,
      oauthConfig: {},
    })
    // The registration flip budget and the insights generation live in Redis, which this suite does not
    // run.
    app = await makeServer({
      env,
      container,
      authServices,
      hostRegistrationOverrides: {
        counters: new InMemoryCounterStore(() => Date.now()),
        insightsInvalidator: { bumpInsightsGeneration: () => Promise.resolve() },
      },
    })
  })

  afterAll(async () => {
    await app?.close()
    await h.teardown()
  })

  async function newUser(email: string = `${testHandle()}@example.org`): Promise<string> {
    const handle = testHandle()
    const [u] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name, handle, email, email_verified, role)
      VALUES (${`Resident ${handle}`}, ${handle}, ${email}, true, 'citizen')
      RETURNING id
    `
    return u!.id
  }

  async function resident(): Promise<Person> {
    const userId = await newUser()
    const token = await authServices.sessions.createSession(userId, ["citizen"])
    const csrfToken = await container.csrf.tokenForSession(token)
    return { userId, cookie: `civfix_session=${token}`, csrfToken }
  }

  function headers(p: Person): Record<string, string> {
    return { cookie: p.cookie, "x-csrf-token": p.csrfToken }
  }

  function accept(p: Person, payload: unknown): Promise<LightMyRequestResponse> {
    return app.inject({
      method: "POST",
      url: "/v1/me/legal/accept",
      headers: headers(p),
      payload: payload as Record<string, unknown>,
    })
  }

  async function status(
    p: Person,
  ): Promise<{ required: { type: string }[]; notices: { type: string }[] }> {
    const res = await app.inject({ method: "GET", url: "/v1/me/legal", headers: headers(p) })
    expect(res.statusCode).toBe(200)
    return res.json()
  }

  function records(userId: string): Promise<StoredRecord[]> {
    return h.sql<StoredRecord[]>`
      SELECT document_type, document_version, document_sha256, action, surface
      FROM consent_records WHERE user_id = ${userId}
      ORDER BY document_type, action
    `
  }

  async function openEvent(): Promise<string> {
    const organizer = await newUser()
    return seedCleanup(h.sql, {
      organizerUserId: organizer,
      title: "Consent sweep",
      scheduledAt: new Date(Date.now() + 7 * 86_400_000),
    })
  }

  const currentConsent = {
    termsVersion: legalDocument("terms").version,
    disclosureVersion: legalDocument("privacy").version,
    hostContactOptIn: true,
    smsOptIn: false,
  }

  function register(
    p: Person,
    cleanupId: string,
    over: Record<string, unknown> = {},
  ): Promise<LightMyRequestResponse> {
    return app.inject({
      method: "POST",
      url: versionedPath(endpoints.registerForEvent).replace(":id", cleanupId),
      headers: headers(p),
      payload: {
        idempotencyKey: randomUUID(),
        partySize: 1,
        joinWaitlistIfFull: false,
        consent: currentConsent,
        ...over,
      },
    })
  }

  async function registrationRows(userId: string, cleanupId: string) {
    const [row] = await h.sql<{ registrations: number; consents: number; records: number }[]>`
      SELECT
        (SELECT count(*)::int FROM cleanup_registrations
          WHERE user_id = ${userId} AND cleanup_id = ${cleanupId}) AS registrations,
        (SELECT count(*)::int FROM event_consents
          WHERE user_id = ${userId} AND cleanup_id = ${cleanupId}) AS consents,
        (SELECT count(*)::int FROM consent_records WHERE user_id = ${userId}) AS records
    `
    return row!
  }

  describe("POST /me/legal/accept", () => {
    it("T25: two concurrent requests of one person write each record once", async () => {
      const u = await resident()
      const [first, second] = await Promise.all([accept(u, T14_BODY), accept(u, T14_BODY)])

      expect([first.statusCode, second.statusCode]).toEqual([200, 200])
      expect((await records(u.userId)).map((r) => [r.document_type, r.action])).toEqual([
        ["cookies", "acknowledged"],
        ["terms", "accepted"],
      ])
    })

    it("T26: of two concurrent sign-ups, one records and the other is refused", async () => {
      const u = await resident()
      const results = await Promise.all([accept(u, SIGNUP_BODY), accept(u, SIGNUP_BODY)])

      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 422])
      const refused = results.find((r) => r.statusCode === 422)!
      expect(refused.json<{ code: string; fields: Record<string, string> }>()).toMatchObject({
        code: "VALIDATION",
        fields: { surface: expect.any(String) },
      })
      expect(await records(u.userId)).toHaveLength(4)
    })

    it("T27: the contract's current versions commit against the document foreign key", async () => {
      const u = await resident()
      const res = await accept(u, SIGNUP_BODY)

      expect(res.statusCode).toBe(200)
      expect(await records(u.userId)).toEqual(
        TYPES.map((type) => ({
          document_type: type,
          document_version: legalDocument(type).version,
          document_sha256: legalDocument(type).sha256,
          action: type === "terms" || type === "privacy" ? "accepted" : "acknowledged",
          surface: "signup",
        })).sort((a, b) => a.document_type.localeCompare(b.document_type)),
      )
      expect(await status(u)).toMatchObject({ required: [], notices: [] })
    })
  })

  describe("registration transaction", () => {
    it("T38: registration, its event consent and the account records commit together", async () => {
      const u = await resident()
      const cleanupId = await openEvent()
      const res = await register(u, cleanupId)

      expect(res.statusCode).toBe(200)
      expect(res.json<{ outcome: string }>().outcome).toBe("registered")
      expect(await registrationRows(u.userId, cleanupId)).toEqual({
        registrations: 1,
        consents: 1,
        records: 2,
      })
      expect(await records(u.userId)).toEqual(
        (["privacy", "terms"] as const).map((type) => ({
          document_type: type,
          document_version: legalDocument(type).version,
          document_sha256: legalDocument(type).sha256,
          action: "accepted",
          surface: "event_registration",
        })),
      )
      const after = await status(u)
      for (const list of [after.required, after.notices]) {
        expect(list.filter((d) => d.type === "terms" || d.type === "privacy")).toEqual([])
      }
    })

    it("T39: a full ticket type writes no registration, consent or record", async () => {
      const cleanupId = await openEvent()
      const [type] = await h.sql<{ id: string }[]>`
        INSERT INTO cleanup_ticket_types (cleanup_id, name, capacity, max_party_size)
        VALUES (${cleanupId}, 'Only one', 1, 1)
        RETURNING id
      `
      const first = await register(await resident(), cleanupId, { ticketTypeId: type!.id })
      expect(first.json<{ outcome: string }>().outcome).toBe("registered")

      const u = await resident()
      const res = await register(u, cleanupId, { ticketTypeId: type!.id })

      expect(res.json<{ outcome: string }>().outcome).toBe("full")
      expect(await registrationRows(u.userId, cleanupId)).toEqual({
        registrations: 0,
        consents: 0,
        records: 0,
      })
    })

    it("T40: a failing consent record insert rolls the registration back", async () => {
      const u = await resident()
      const cleanupId = await openEvent()
      // NOT VALID checks new rows only, so the records earlier cases committed stay.
      await h.sql`
        ALTER TABLE consent_records ADD CONSTRAINT t40_refuse_event_records
          CHECK (surface <> 'event_registration') NOT VALID
      `
      try {
        const res = await register(u, cleanupId)
        expect(res.statusCode).toBe(500)
        expect(res.json<{ message: string }>().message).toContain("t40_refuse_event_records")
      } finally {
        await h.sql`ALTER TABLE consent_records DROP CONSTRAINT t40_refuse_event_records`
      }
      expect(await registrationRows(u.userId, cleanupId)).toEqual({
        registrations: 0,
        consents: 0,
        records: 0,
      })
    })
  })

  describe("data export and the demo purge", () => {
    async function seedRecord(
      userId: string,
      type: LegalDocumentType,
      action: string,
      surface: string,
      at: Date,
    ): Promise<void> {
      const document = legalDocument(type)
      await h.sql`
        INSERT INTO consent_records
          (subject_kind, user_id, document_type, document_version, document_sha256, action, surface,
           accepted_at)
        VALUES ('user', ${userId}, ${type}, ${document.version}, ${document.sha256}, ${action},
                ${surface}, ${at})
      `
    }

    it("T43: the export carries exactly the person's own records, newest first", async () => {
      const u = await newUser()
      const u2 = await newUser()
      const base = Date.parse("2026-10-01T00:00:00.000Z")
      await seedRecord(u, "terms", "accepted", "signup", new Date(base))
      await seedRecord(u, "cookies", "acknowledged", "notice", new Date(base + 2000))
      await seedRecord(u, "privacy", "accepted", "event_registration", new Date(base + 1000))
      await seedRecord(u2, "terms", "accepted", "prompt", new Date(base + 3000))
      await seedRecord(u2, "privacy", "accepted", "prompt", new Date(base + 3000))
      await h.sql`
        INSERT INTO consent_records
          (subject_kind, user_id, donor_key, document_type, document_version, document_sha256, surface)
        VALUES ('donor', ${u}, gen_random_uuid(), 'donations', '2026-09-06',
                '461190ba108e771ff6a3c89cec0b5451bf5d05ff89e33231ff4c5493e0723544', 'web_donate')
      `

      const mailer = new FakeMailer()
      await makeDataExportService({
        sql: h.sql,
        mailer,
        users: authServices.users,
        fromNoReply: "no-reply@civfix.test",
        supportEmail: "support@civfix.test",
      }).exportData(u)
      const attachment = mailer.lastOutbound()!.attachments![0]!
      const parsed = JSON.parse(new TextDecoder().decode(attachment.content)) as {
        consentRecords: Record<string, unknown>[]
      }
      const row = (type: LegalDocumentType, action: string, surface: string, at: number) => ({
        document_type: type,
        document_version: legalDocument(type).version,
        document_sha256: legalDocument(type).sha256,
        action,
        surface,
        accepted_at: new Date(at).toISOString(),
      })
      expect(parsed.consentRecords).toEqual([
        row("cookies", "acknowledged", "notice", base + 2000),
        row("privacy", "accepted", "event_registration", base + 1000),
        row("terms", "accepted", "signup", base),
      ])
    })

    it("T44: the demo purge deletes the demo accounts' records and no one else's", async () => {
      const demoA = await newUser(`a-${testHandle()}@${DEMO_EMAIL_DOMAIN}`)
      const demoB = await newUser(`b-${testHandle()}@${DEMO_EMAIL_DOMAIN}`)
      const real = await newUser()
      const at = new Date("2026-10-01T00:00:00.000Z")
      for (const userId of [demoA, demoB, real]) {
        await seedRecord(userId, "terms", "accepted", "signup", at)
      }

      const counts = await h.sql.begin((tx) => purgeDemo(tx))

      expect(counts.consent_records).toBe(2)
      const left = await h.sql<{ user_id: string }[]>`
        SELECT user_id FROM consent_records WHERE user_id IN (${demoA}, ${demoB}, ${real})
      `
      expect(left).toEqual([{ user_id: real }])
    })
  })
})
