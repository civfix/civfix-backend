import { afterEach, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import type { FastifyInstance, LightMyRequestResponse } from "fastify"
import { FakeMailer } from "@civfix/seams"
import { LegalVersionOutdatedDetailsSchema } from "@civfix/contract"
import { endpoints, versionedPath } from "@civfix/contract/client"
import { makeServer } from "../../../src/server.js"
import { makeContainer } from "../../../src/di.js"
import { loadEnv } from "../../../src/env.js"
import { InMemoryCounterStore } from "../../../src/abuse/counter-store.js"
import { InMemoryCacheClient } from "../../../src/auth/cache.js"
import { makeInMemoryStores } from "../../../src/auth/stores.js"
import { makeAuthServices } from "../../../src/auth/auth-services.js"
import { OPEN_HOST_GUARDS } from "../../../src/services/host/registration-wiring.js"
import { makeTicketTokenSigner } from "../../../src/services/host/ticket-token.js"
import { StubJwksVerifier } from "../../helpers/auth.js"
import { InMemoryHostRegistrationRepository } from "../../helpers/host/registration-repository.memory.js"
import { C, V, outdatedDetails, sha } from "../../helpers/legal-acceptance-fixtures.js"

// Event registration's consent check (DECISIONS D7), through registerForEvent on the V versions at
// clock C.

const EVENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const tokens = makeTicketTokenSigner("registration-consent-test-secret-long-enough")

interface Harness {
  app: FastifyInstance
  repo: InMemoryHostRegistrationRepository
  userId: string
  token: string
}

let current: Harness | undefined

afterEach(async () => {
  await current?.app.close()
  current = undefined
})

async function harness(): Promise<Harness> {
  const env = loadEnv({ NODE_ENV: "test" })
  const stores = makeInMemoryStores()
  const authServices = makeAuthServices({
    stores,
    cache: new InMemoryCacheClient(() => Date.now()),
    mailer: new FakeMailer(),
    oauthConfig: {},
    verifier: new StubJwksVerifier(),
    now: () => Date.now(),
  })
  const repo = new InMemoryHostRegistrationRepository()
  repo.tokenHashResolver = (seatId) => tokens.hashFor(seatId)
  repo.seedEvent({
    cleanupId: EVENT,
    scheduledAt: new Date(C.getTime() + 7 * 86_400_000),
    endsAt: new Date(C.getTime() + 7 * 86_400_000 + 3_600_000),
  })
  const app = await makeServer({
    env,
    container: makeContainer(env),
    authServices,
    hostRegistrationOverrides: {
      repo,
      tokens,
      guards: OPEN_HOST_GUARDS,
      counters: new InMemoryCounterStore(() => C.getTime()),
      now: () => C,
      legalVersions: V,
    },
  })
  const user = await stores.users.create("registrant@example.org", {
    displayName: "Registrant",
    role: "citizen",
    emailVerified: true,
  })
  const token = await authServices.sessions.createSession(user.id, ["citizen"])
  current = { app, repo, userId: user.id, token }
  return current
}

function register(
  h: Harness,
  consent: { termsVersion: string; disclosureVersion: string } | null,
  idempotencyKey: string = randomUUID(),
): Promise<LightMyRequestResponse> {
  return h.app.inject({
    method: "POST",
    url: versionedPath(endpoints.registerForEvent).replace(":id", EVENT),
    headers: { authorization: `Bearer ${h.token}` },
    payload: {
      idempotencyKey,
      partySize: 1,
      joinWaitlistIfFull: false,
      ...(consent === null
        ? {}
        : { consent: { ...consent, hostContactOptIn: true, surface: "web_register" } }),
    },
  })
}

const PREVIOUS_MINOR = { termsVersion: "2026-11-02", disclosureVersion: "2026-09-21" }

describe("registerForEvent consent (DECISIONS D7)", () => {
  it("T32: the versions before the current minor ones register and count as accepted", async () => {
    const h = await harness()
    const res = await register(h, PREVIOUS_MINOR)

    expect(res.statusCode).toBe(200)
    expect(res.json<{ outcome: string }>().outcome).toBe("registered")
    expect(h.repo.eventConsents).toHaveLength(1)
    expect(h.repo.eventConsents[0]?.consent).toMatchObject({
      termsVersion: "2026-11-02",
      disclosureVersion: "2026-09-21",
      surface: "web_register",
    })
    expect(h.repo.consentRecords).toEqual([
      {
        userId: h.userId,
        type: "terms",
        version: "2026-11-02",
        sha256: sha("terms@2026-11-02"),
        action: "accepted",
        surface: "event_registration",
        acceptedAt: C,
      },
      {
        userId: h.userId,
        type: "privacy",
        version: "2026-09-21",
        sha256: sha("privacy@2026-09-21"),
        action: "accepted",
        surface: "event_registration",
        acceptedAt: C,
      },
    ])
  })

  it("T33: older versions are outdated and nothing is written", async () => {
    const h = await harness()
    const res = await register(h, { termsVersion: "2026-10-26", disclosureVersion: "2026-10-26" })

    expect(res.statusCode).toBe(409)
    const body = res.json<{ code: string; details: unknown }>()
    expect(body.code).toBe("CONFLICT")
    expect(body.details).toEqual(outdatedDetails(["terms", "privacy"]))
    expect(LegalVersionOutdatedDetailsSchema.safeParse(body.details).success).toBe(true)
    expect(h.repo.registrations.size).toBe(0)
    expect(h.repo.eventConsents).toEqual([])
    expect(h.repo.consentRecords).toEqual([])
  })

  it("T34: a registration without consent writes no consent record", async () => {
    const h = await harness()
    const res = await register(h, null)

    expect(res.statusCode).toBe(200)
    expect(res.json<{ outcome: string }>().outcome).toBe("registered")
    expect(h.repo.consentRecords).toEqual([])
  })

  it("T35: a replay writes no second consent", async () => {
    const h = await harness()
    const key = randomUUID()
    await register(h, PREVIOUS_MINOR, key)
    const replay = await register(h, PREVIOUS_MINOR, key)

    expect(replay.statusCode).toBe(200)
    expect(replay.json<{ outcome: string }>().outcome).toBe("replayed")
    expect(h.repo.eventConsents).toHaveLength(1)
    expect(h.repo.consentRecords).toHaveLength(2)
  })
})
