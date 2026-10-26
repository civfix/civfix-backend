/**
 * The kill switch and the outreach digest read their runtime flag at the moment they act (#252), over a
 * flag service built once and flipped afterwards. The handlers that need real SQL (the digest run, the
 * auto-forward job, canForwardToCity, report submission) are in
 * test/integration/runtime-flag-wiring-pg.test.ts.
 */

import { afterEach, describe, expect, it } from "vitest"
import type { FastifyInstance } from "fastify"
import { FakeJobs, FakeMailer } from "@civfix/seams"
import { makeServer } from "../../src/server.js"
import { makeContainer, type Container } from "../../src/di.js"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { makeInMemoryStores } from "../../src/auth/stores.js"
import { makeAuthServices } from "../../src/auth/auth-services.js"
import { parseBool } from "../../src/env/parsers.js"
import { broadcastConfigOf } from "../../src/services/host/comms-wiring.js"
import { registerOutreachJobs } from "../../src/services/admin/outreach-jobs.js"
import { OUTREACH_DIGEST_JOB } from "../../src/lib/queue-names.js"
import type { RuntimeFlagService } from "../../src/services/admin/runtime-flag-service.js"
import { StubJwksVerifier } from "../helpers/auth.js"
import { InMemoryJurisdictionContactsRepository } from "../helpers/admin/jurisdiction-contacts-repository.memory.js"
import {
  ENV_SWITCH_VALUES,
  HandlerJobs,
  OPERATOR_ID,
  envWith,
  flagHarness,
} from "../helpers/runtime-flags.js"

const OPERATOR_EMAIL = "ops@civfix.org"

function commsContainer(env: Container["env"], flags: RuntimeFlagService): Container {
  return { env, getRuntimeFlags: () => flags } as unknown as Container
}

describe("the broadcast kill switch reads host_messaging_kill_switch at each check", () => {
  it("T4: follows the flag set and cleared after the config was built", async () => {
    const { env, flags } = flagHarness()
    const config = broadcastConfigOf(commsContainer(env, flags))

    expect(await config.killSwitch()).toBe(false)
    await flags.set("host_messaging_kill_switch", true, OPERATOR_ID)
    expect(await config.killSwitch()).toBe(true)
    await flags.set("host_messaging_kill_switch", null, OPERATOR_ID)
    expect(await config.killSwitch()).toBe(false)
  })

  it("T5: reads on when the flag store fails before any snapshot", async () => {
    const { env, repo, flags } = flagHarness()
    repo.loadAllError = new Error("database down")
    const config = broadcastConfigOf(commsContainer(env, flags))

    expect(await config.killSwitch()).toBe(true)
  })

  it("T6: keeps the last good snapshot when a later refresh fails", async () => {
    const { env, repo, flags, clock } = flagHarness({ HOST_MESSAGING_KILL_SWITCH: "true" })
    repo.seed("host_messaging_kill_switch", false)
    const config = broadcastConfigOf(commsContainer(env, flags))

    expect(await config.killSwitch()).toBe(false)
    repo.loadAllError = new Error("database down")
    clock.now += 6_000
    expect(await config.killSwitch()).toBe(false)
    expect(repo.loadAllCalls).toBe(2)
  })

  it.each(ENV_SWITCH_VALUES)(
    "T17: with no override, HOST_MESSAGING_KILL_SWITCH=$raw reads $on",
    async ({ raw, on }) => {
      const { env, flags } = flagHarness(envWith("HOST_MESSAGING_KILL_SWITCH", raw))
      const config = broadcastConfigOf(commsContainer(env, flags))

      expect(await config.killSwitch()).toBe(on)
      expect(on).toBe(parseBool(raw, false))
    },
  )
})

describe("the outreach digest cron is always scheduled", () => {
  it.each([
    { label: "unset", source: {} },
    { label: "1", source: { OUTREACH_DIGEST_ENABLED: "1" } },
  ])("T7: OUTREACH_DIGEST_ENABLED $label", async ({ source }) => {
    const { env, flags } = flagHarness(source)
    const jobs = new HandlerJobs()
    const container = {
      env,
      jobs,
      mailer: new FakeMailer(),
      getDb: () => ({ sql: {} }),
      getRuntimeFlags: () => flags,
    } as unknown as Container

    await registerOutreachJobs(container)

    expect(jobs.scheduled).toEqual([{ name: OUTREACH_DIGEST_JOB, cron: env.OUTREACH_DIGEST_CRON }])
    expect(jobs.workers.has(OUTREACH_DIGEST_JOB)).toBe(true)
  })
})

describe("POST /v1/admin/jurisdictions/:geoid/contacts reads outreach_digest_enabled per save", () => {
  let app: FastifyInstance | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  it("T10: the overrides path enqueues a digest only once the flag is on", async () => {
    const stores = makeInMemoryStores()
    const services = makeAuthServices({
      stores,
      cache: new InMemoryCacheClient(() => Date.now()),
      mailer: new FakeMailer(),
      oauthConfig: {},
      verifier: new StubJwksVerifier(),
      now: () => Date.now(),
    })
    const { env, flags } = flagHarness({ ADMIN_EMAILS: OPERATOR_EMAIL })
    const container: Container = { ...makeContainer(env), getRuntimeFlags: () => flags }
    app = await makeServer({ env, container, authServices: services })
    const repo = new InMemoryJurisdictionContactsRepository()
    repo.seedJurisdiction({ geoid: "0644000", name: "Los Angeles" })
    repo.seedJurisdiction({ geoid: "0667000", name: "San Francisco" })
    const jobs = new FakeJobs()
    app.jurisdictionOverrides = { repo, jobs }

    const operator = await stores.users.create(OPERATOR_EMAIL, {
      displayName: "Ops",
      role: "operator",
      emailVerified: true,
    })
    const token = await services.sessions.createSession(operator.id, ["operator"])
    const headers = {
      cookie: `civfix_session=${token}`,
      "x-csrf-token": await container.csrf.tokenForSession(token),
    }
    const save = (geoid: string) =>
      app!.inject({
        method: "POST",
        url: `/v1/admin/jurisdictions/${geoid}/contacts`,
        headers,
        payload: { contacts: { trash: `trash@${geoid}.gov` }, defaultEmails: [], formUrl: null },
      })

    expect((await save("0644000")).statusCode).toBe(200)
    expect(jobs.jobsFor(OUTREACH_DIGEST_JOB)).toHaveLength(0)

    await flags.set("outreach_digest_enabled", true, OPERATOR_ID)
    expect((await save("0667000")).statusCode).toBe(200)
    const enqueued = jobs.jobsFor(OUTREACH_DIGEST_JOB)
    expect(enqueued).toHaveLength(1)
    expect(enqueued[0]?.data).toEqual({ geoid: "0667000" })
  })
})
