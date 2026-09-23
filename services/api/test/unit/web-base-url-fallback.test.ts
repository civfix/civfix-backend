import { describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import type { HostCapability } from "@civfix/shared"
import { FakeAbuseChecks, FakeMailer, FakeSmsSender } from "@civfix/shared/fakes"
import { InMemoryCounterStore } from "../../src/abuse/counter-store.js"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { makeContainer } from "../../src/di.js"
import { loadEnv } from "../../src/env.js"
import { makeServer } from "../../src/server.js"
import type { HostStandingResolution } from "../../src/services/host/host-standing-repository.drizzle.js"
import { InMemoryHostTeamRepository } from "../../src/services/host/host-team-repository.memory.js"
import {
  makeHostTeamService,
  type HostTeamServiceDeps,
} from "../../src/services/host/host-team-service.js"
import { InMemoryOrganizationRepository } from "../../src/services/host/organization-repository.memory.js"
import {
  makeOrganizationService,
  type OrganizationServiceDeps,
} from "../../src/services/host/organization-service.js"
import { webBaseUrlOf } from "../../src/lib/base-url.js"
import { InMemoryGuestRsvpRepository } from "../helpers/guest-rsvp.js"
import { fakeCleanupDTO } from "../helpers/host-team.js"

const LOCAL_WEB = "http://localhost:3000"
const PRODUCTION_WEB = "https://civfix.org"
const EVENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const ORGANIZER = "11111111-1111-4111-8111-111111111111"
const OWNER = "22222222-2222-4222-8222-222222222222"

function mailText(mailer: FakeMailer): string {
  return JSON.stringify(mailer.sent.map((m) => m.vars))
}

describe("links mailed from a runtime with no web origin configured", () => {
  it("point an event team invite at the local web app", async () => {
    const mailer = new FakeMailer()
    const repo = new InMemoryHostTeamRepository()
    repo.seedUser({ id: ORGANIZER, displayName: "Olive Organizer", handle: "olive" })
    repo.seedMember(EVENT, ORGANIZER, "organizer")
    const service = makeHostTeamService({
      repo,
      standing: (cleanupId: string, _userId: string, _capability: HostCapability) => {
        const resolution: HostStandingResolution = {
          cleanupId,
          standing: { eventRole: "organizer", orgRole: null },
          organizerUserId: ORGANIZER,
          organizationId: null,
          visibility: "public",
        }
        return Promise.resolve(resolution)
      },
      counters: new InMemoryCounterStore(),
      mailer,
      loadEvent: (cleanupId: string) => Promise.resolve(fakeCleanupDTO(cleanupId)),
      notifier: { createNotification: () => Promise.resolve(null) },
      eventTitleOf: () => Promise.resolve("Beach cleanup"),
      webOrigin: webBaseUrlOf({ NODE_ENV: "test" }),
    })

    await service.inviteMember(EVENT, ORGANIZER, {
      identifierKind: "email",
      identifier: "helper@x.org",
      role: "cohost",
    })

    expect(mailText(mailer)).toContain(`${LOCAL_WEB}/cleanups/${EVENT}#teamInvite=`)
    expect(mailText(mailer)).not.toContain(PRODUCTION_WEB)
  })

  it("point an organization invite at the local web app", async () => {
    const mailer = new FakeMailer()
    const repo = new InMemoryOrganizationRepository()
    repo.seedUser({ id: OWNER, displayName: "Olive Owner", handle: "olive", email: "o@x.org" })
    const service = makeOrganizationService({
      repo,
      counters: new InMemoryCounterStore(),
      newId: () => randomUUID(),
      mailer,
      webOrigin: webBaseUrlOf({ NODE_ENV: "test" }),
    })
    const org = await service.createOrganization(
      { name: "Creek Trust", slug: "creek-trust" } as Parameters<
        typeof service.createOrganization
      >[0],
      OWNER,
    )

    await service.inviteMember(org.id, OWNER, {
      identifierKind: "email",
      identifier: "helper@x.org",
      role: "member",
    })

    expect(mailText(mailer)).toContain(`${LOCAL_WEB}/manage/org-invites/accept#token=`)
    expect(mailText(mailer)).not.toContain(PRODUCTION_WEB)
  })

  it("point a guest's cancel link at the local web app", async () => {
    const env = loadEnv({ NODE_ENV: "test" })
    const mailer = new FakeMailer()
    const repo = new InMemoryGuestRsvpRepository()
    repo.seedEvent({ id: EVENT, title: "Beach cleanup" })
    const app = await makeServer({
      env,
      container: makeContainer(env),
      guestRsvpOverrides: {
        repo,
        requireGuestContact: () => Promise.resolve(),
        cache: new InMemoryCacheClient(),
        counters: new InMemoryCounterStore(),
        mailer,
        smsSender: new FakeSmsSender(),
        abuseChecks: new FakeAbuseChecks(),
      },
    })
    try {
      const contact = { channel: "email", email: "ada@example.org" }
      const requested = await app.inject({
        method: "POST",
        url: `/v1/cleanups/${EVENT}/guest-rsvp/request`,
        payload: { name: "Ada", ...contact, turnstileToken: "ok" },
      })
      expect(requested.statusCode, requested.body).toBe(200)
      const code = mailer.sent.find((m) => m.template === "guest_otp")?.vars?.code
      const verified = await app.inject({
        method: "POST",
        url: `/v1/cleanups/${EVENT}/guest-rsvp/verify`,
        payload: { ...contact, code },
      })
      expect(verified.statusCode, verified.body).toBe(200)

      const confirmed = mailer.sent.find((m) => m.template === "guest_confirmed")
      expect(String(confirmed?.vars?.cancelUrl)).toMatch(new RegExp(`^${LOCAL_WEB}/guest\\?token=`))
    } finally {
      await app.close()
    }
  })
})

describe("services that mail links", () => {
  it("cannot be built without the web origin the route wiring resolves from the environment", () => {
    // @ts-expect-error a missing origin would otherwise fall back to localhost even in production
    const team: HostTeamServiceDeps = {
      repo: new InMemoryHostTeamRepository(),
      standing: () => Promise.reject(new Error("unused")),
      loadEvent: () => Promise.reject(new Error("unused")),
    }
    // @ts-expect-error a missing origin would otherwise fall back to localhost even in production
    const org: OrganizationServiceDeps = { repo: new InMemoryOrganizationRepository() }

    expect([team, org]).toHaveLength(2)
  })
})
