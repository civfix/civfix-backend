import { beforeEach, describe, expect, it, vi } from "vitest"
import { randomUUID } from "node:crypto"
import { InMemoryCounterStore } from "../../../src/abuse/counter-store.js"
import { makeDrizzleOrganizationRepository } from "../../../src/services/host/organization-repository.drizzle.js"
import {
  makeOrganizationService,
  type OrganizationService,
} from "../../../src/services/host/organization-service.js"
import { InMemoryOrganizationRepository } from "../../helpers/host/organization-repository.memory.js"
import { makeSqlRecorder } from "../../helpers/sql-recorder.js"

const OWNER = "11111111-1111-4111-8111-111111111111"
const ADMIN = "22222222-2222-4222-8222-222222222222"
const MEMBER = "33333333-3333-4333-8333-333333333333"
const STRANGER = "44444444-4444-4444-8444-444444444444"
const INVITE = "88888888-8888-4888-8888-888888888888"
const SUSPENDED_COPY = "This organization has been suspended, so it can't be changed right now."

let repo: InMemoryOrganizationRepository
let service: OrganizationService

beforeEach(() => {
  repo = new InMemoryOrganizationRepository()
  repo.seedUser({ id: OWNER, displayName: "Olive Owner", handle: "olive", email: "olive@x.org" })
  repo.seedUser({ id: ADMIN, displayName: "Adam Admin", handle: "adam", email: "adam@x.org" })
  repo.seedUser({ id: MEMBER, displayName: "Mel Member", handle: "mel", email: "mel@x.org" })
  repo.seedUser({ id: STRANGER, displayName: "Stan Stranger", handle: "stan", email: "stan@x.org" })
  const clock = new Date("2026-09-06T12:00:00.000Z")
  service = makeOrganizationService({
    repo,
    counters: new InMemoryCounterStore(() => clock.getTime()),
    now: () => clock,
    newId: () => randomUUID(),
    webOrigin: "https://civfix.test/",
  })
})

async function seededOrg(): Promise<string> {
  const dto = await service.createOrganization(
    { name: "Ballona Creek Trust", slug: "ballona-creek-trust" },
    OWNER,
  )
  for (const [handle, role] of [
    ["adam", "admin"],
    ["mel", "member"],
  ] as const) {
    await service.inviteMember(dto.id, OWNER, {
      identifierKind: "handle",
      identifier: handle,
      role,
    })
  }
  return dto.id
}

type Gated = (id: string, actorId: string) => Promise<unknown>

const GATED: Record<string, Gated> = {
  updateOrganization: (id, actorId) => service.updateOrganization(id, { name: "Renamed" }, actorId),
  listMembers: (id, actorId) => service.listMembers(id, actorId, { cursor: null, limit: 10 }),
  inviteMember: (id, actorId) =>
    service.inviteMember(id, actorId, {
      identifierKind: "email",
      identifier: "new@x.org",
      role: "member",
    }),
  listInvites: (id, actorId) => service.listInvites(id, actorId),
  revokeInvite: (id, actorId) => service.revokeInvite(id, actorId, INVITE),
  setMemberRole: (id, actorId) => service.setMemberRole(id, actorId, MEMBER, "admin"),
  removeMember: (id, actorId) => service.removeMember(id, actorId, ADMIN),
  applyVerification: (id, actorId) =>
    service.applyVerification(id, actorId, { kind: "nonprofit_501c3", documents: [] } as never),
  getVerification: (id, actorId) => service.getVerification(id, actorId),
}

const MANAGE_GATES = [
  "updateOrganization",
  "inviteMember",
  "listInvites",
  "revokeInvite",
  "setMemberRole",
  "removeMember",
  "applyVerification",
]

const SUSPENSION_GATED = [
  "updateOrganization",
  "inviteMember",
  "setMemberRole",
  "applyVerification",
]

async function outcome(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
    return "ok"
  } catch (err) {
    const { code, message } = err as { code?: string; message?: string }
    return code === "FORBIDDEN" && message === SUSPENDED_COPY ? "SUSPENDED" : String(code)
  }
}

describe("organization gates read the access record, not the public profile", () => {
  for (const [name, run] of Object.entries(GATED)) {
    it(`${name} authorizes with one access lookup and no profile read before the gate`, async () => {
      const id = await seededOrg()
      const access = vi.spyOn(repo, "findOrganizationAccess")
      const profile = vi.spyOn(repo, "findOrganizationById")

      await outcome(() => run(id, OWNER))

      expect(access).toHaveBeenCalledTimes(1)
      expect(access).toHaveBeenCalledWith(id, OWNER)
      const profileReads = name === "updateOrganization" ? 1 : 0
      expect(profile).toHaveBeenCalledTimes(profileReads)
      if (profileReads > 0) {
        expect(access.mock.invocationCallOrder[0]).toBeLessThan(
          profile.mock.invocationCallOrder[0] ?? 0,
        )
      }
    })
  }

  it("answers 404 for a deleted org and for a non-member, on every gate", async () => {
    const id = await seededOrg()
    for (const [name, run] of Object.entries(GATED)) {
      expect(await outcome(() => run(id, STRANGER)), name).toBe("NOT_FOUND")
    }
    const stored = repo.organizations.get(id)
    if (stored === undefined) throw new Error("seeded org missing")
    stored.deletedAt = new Date("2026-09-01T00:00:00.000Z")
    for (const [name, run] of Object.entries(GATED)) {
      expect(await outcome(() => run(id, OWNER)), name).toBe("NOT_FOUND")
    }
  })

  it("answers 403 to a plain member on every manage gate", async () => {
    const id = await seededOrg()
    for (const name of MANAGE_GATES) {
      const run = GATED[name]
      if (run === undefined) throw new Error(name)
      expect(await outcome(() => run(id, MEMBER)), name).toBe("FORBIDDEN")
    }
  })

  it("checks capability before suspension, then suspension, on a suspended org", async () => {
    const id = await seededOrg()
    const stored = repo.organizations.get(id)
    if (stored === undefined) throw new Error("seeded org missing")
    stored.suspendedAt = new Date("2026-09-01T00:00:00.000Z")
    for (const name of SUSPENSION_GATED) {
      const run = GATED[name]
      if (run === undefined) throw new Error(name)
      expect(await outcome(() => run(id, OWNER)), name).toBe("SUSPENDED")
      expect(await outcome(() => run(id, MEMBER)), name).toBe("FORBIDDEN")
      expect(await outcome(() => run(id, STRANGER)), name).toBe("NOT_FOUND")
    }
  })

  it("still refuses a second verification application once the org is verified", async () => {
    const id = await seededOrg()
    const stored = repo.organizations.get(id)
    if (stored === undefined) throw new Error("seeded org missing")
    stored.verifiedStatus = "verified"
    expect(await outcome(() => GATED.applyVerification!(id, OWNER))).toBe("CONFLICT")
  })
})

describe("findOrganizationAccess SQL", () => {
  it("is one primary-key statement with the viewer role subquery and none of the profile aggregates", async () => {
    const rec = makeSqlRecorder()
    rec.enqueue([
      {
        id: "org-1",
        slug: "ballona",
        name: "Ballona",
        suspended_at: null,
        verified_status: "unverified",
        my_role: "admin",
      },
    ])
    const record = await makeDrizzleOrganizationRepository(rec.sql).findOrganizationAccess(
      "org-1",
      ADMIN,
    )

    expect(record).toEqual({
      id: "org-1",
      slug: "ballona",
      name: "Ballona",
      suspendedAt: null,
      verifiedStatus: "unverified",
      myRole: "admin",
    })
    expect(rec.queries).toHaveLength(1)
    const [query] = rec.queries
    expect(query?.text).toMatch(
      /FROM organizations o WHERE o\.id = \$\d+ AND o\.deleted_at IS NULL/,
    )
    expect(query?.text).toMatch(
      /SELECT om\.role FROM organization_members om WHERE om\.organization_id = o\.id AND om\.user_id = \$\d+::uuid LIMIT 1/,
    )
    expect(query?.text).not.toMatch(/media_assets|volunteer_hours|member_count|event_count/)
    expect(query?.params).toEqual([ADMIN, "org-1"])
  })

  it("returns null when no row comes back", async () => {
    const rec = makeSqlRecorder()
    const repository = makeDrizzleOrganizationRepository(rec.sql)
    expect(await repository.findOrganizationAccess("org-1", ADMIN)).toBeNull()
  })
})
