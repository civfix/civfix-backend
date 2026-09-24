import { beforeEach, describe, expect, it } from "vitest"
import type { HostCapability } from "@civfix/shared"
import { InMemoryCounterStore } from "../../../src/abuse/counter-store.js"
import type { HostStandingResolution } from "../../../src/services/host/host-standing.js"
import { InMemoryHostTeamRepository } from "../../../src/services/host/host-team-repository.memory.js"
import { makeDrizzleHostTeamRepository } from "../../../src/services/host/host-team-repository.drizzle.js"
import {
  makeHostTeamService,
  type HostTeamService,
} from "../../../src/services/host/host-team-service.js"
import type { CreateNotificationInput } from "../../../src/services/notification-service.js"
import { fakeCleanupDTO } from "../../helpers/host-team.js"
import { makeFakeSql } from "../../helpers/fake-sql.js"
import type { Sql } from "../../../src/db/client.js"

const EVENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const ORGANIZER = "11111111-1111-4111-8111-111111111111"
const UNVERIFIED = "22222222-2222-4222-8222-222222222222"
const VERIFIED = "33333333-3333-4333-8333-333333333333"

let repo: InMemoryHostTeamRepository
let service: HostTeamService
let sentMail: string[]
let bells: string[]
let tokenSeq: number

beforeEach(() => {
  repo = new InMemoryHostTeamRepository()
  sentMail = []
  bells = []
  tokenSeq = 0
  const clock = new Date("2026-09-06T12:00:00.000Z")
  repo.seedUser({ id: ORGANIZER, displayName: "Olive Organizer", handle: "olive" })
  repo.seedUser({
    id: UNVERIFIED,
    displayName: "Una Unverified",
    handle: "una",
    email: "victim@x.org",
    emailVerified: false,
  })
  repo.seedUser({ id: VERIFIED, displayName: "Vera Verified", handle: "vera", email: "vera@x.org" })
  repo.seedMember(EVENT, ORGANIZER, "organizer")
  service = makeHostTeamService({
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
    counters: new InMemoryCounterStore(() => clock.getTime()),
    mailer: {
      sendTransactional: (to) => {
        sentMail.push(to)
        return Promise.resolve()
      },
    },
    loadEvent: (cleanupId: string) => Promise.resolve(fakeCleanupDTO(cleanupId)),
    notifier: {
      createNotification: (userId: string, _input: CreateNotificationInput) => {
        bells.push(userId)
        return Promise.resolve(null)
      },
    },
    eventTitleOf: () => Promise.resolve("Beach cleanup"),
    webOrigin: "https://civfix.test",
    now: () => clock,
    newToken: () => `token-${++tokenSeq}-aaaaaaaaaaaaaaaaaaaaaaaa`,
    newId: () => `cccccccc-cccc-4ccc-8ccc-${String(tokenSeq).padStart(12, "0")}`,
  })
})

describe("handle team invites", () => {
  it("never emails an address the account has not verified, but still tells the account in-app", async () => {
    await service.inviteMember(EVENT, ORGANIZER, {
      identifierKind: "handle",
      identifier: "una",
      role: "staff",
    })

    expect(sentMail).toEqual([])
    expect(bells).toEqual([UNVERIFIED])
  })

  it("emails a verified address as before", async () => {
    await service.inviteMember(EVENT, ORGANIZER, {
      identifierKind: "handle",
      identifier: "vera",
      role: "staff",
    })

    expect(sentMail).toEqual(["vera@x.org"])
    expect(bells).toEqual([VERIFIED])
  })

  it("reads the address only when it is verified", async () => {
    const fake = makeFakeSql([{ match: /FROM users/, rows: [{ id: UNVERIFIED, email: null }] }])

    const resolved = await makeDrizzleHostTeamRepository(
      fake.sql as unknown as Sql,
    ).resolveUserByHandle("una")

    expect(resolved).toEqual({ userId: UNVERIFIED, email: null })
    expect(fake.statements[0]!.sql.replace(/\s+/g, " ")).toContain(
      "CASE WHEN email_verified THEN email END AS email",
    )
  })
})
