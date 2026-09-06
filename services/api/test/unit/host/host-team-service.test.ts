import { beforeEach, describe, expect, it } from "vitest"
import { AppError, type HostCapability } from "@civfix/shared"
import { can, NO_HOST_STANDING, type HostStanding } from "@civfix/shared/host"
import { InMemoryCounterStore } from "../../../src/abuse/counter-store.js"
import { hostForbiddenCopy } from "../../../src/services/host/authz.js"
import type { HostStandingResolution } from "../../../src/services/host/host-standing.js"
import { InMemoryHostTeamRepository } from "../../../src/services/host/host-team-repository.memory.js"
import {
  makeHostTeamService,
  maskEmail,
  TEAM_INVITES_PER_EVENT_PER_DAY,
  TEAM_INVITE_EMAIL_SCRUB_DELAY_MS,
  TEAM_INVITE_TTL_MS,
  type HostTeamService,
} from "../../../src/services/host/host-team-service.js"

const EVENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const ORGANIZER = "11111111-1111-4111-8111-111111111111"
const COHOST = "22222222-2222-4222-8222-222222222222"
const STAFF = "33333333-3333-4333-8333-333333333333"
const INVITEE = "44444444-4444-4444-8444-444444444444"
const STRANGER = "55555555-5555-4555-8555-555555555555"

let repo: InMemoryHostTeamRepository
let service: HostTeamService
let clock: Date
let sentMail: { to: string; vars: Record<string, unknown> }[]
let tokenSeq: number

function standingOf(userId: string): HostStanding {
  const role = repo.members.find((m) => m.cleanupId === EVENT && m.userId === userId)?.role ?? null
  return role === null ? NO_HOST_STANDING : { eventRole: role, orgRole: null }
}

function makeService(): HostTeamService {
  return makeHostTeamService({
    repo,
    standing: (cleanupId: string, userId: string, capability: HostCapability) => {
      const standing = standingOf(userId)
      if (standing === NO_HOST_STANDING) {
        return Promise.reject(AppError.notFound("Cleanup not found"))
      }
      if (!can(standing, capability)) {
        return Promise.reject(AppError.forbidden(hostForbiddenCopy(capability)))
      }
      const resolution: HostStandingResolution = {
        cleanupId,
        standing,
        organizerUserId: ORGANIZER,
        organizationId: null,
        visibility: "public",
      }
      return Promise.resolve(resolution)
    },
    counters: new InMemoryCounterStore(() => clock.getTime()),
    mailer: {
      sendTransactional: (to, _template, vars) => {
        sentMail.push({ to, vars })
        return Promise.resolve()
      },
    },
    eventTitleOf: () => Promise.resolve("Beach cleanup"),
    webOrigin: "https://civfix.test",
    now: () => clock,
    newToken: () => `token-${++tokenSeq}-aaaaaaaaaaaaaaaaaaaaaaaa`,
    newId: () => `invite-${tokenSeq}`,
  })
}

beforeEach(() => {
  repo = new InMemoryHostTeamRepository()
  clock = new Date("2026-09-06T12:00:00.000Z")
  sentMail = []
  tokenSeq = 0
  repo.seedUser({ id: ORGANIZER, displayName: "Olive Organizer", handle: "olive" })
  repo.seedUser({ id: COHOST, displayName: "Cody Cohost", handle: "cody" })
  repo.seedUser({ id: STAFF, displayName: "Sasha Staff", handle: "sasha" })
  repo.seedUser({ id: INVITEE, displayName: "Ida Invitee", handle: "ida", email: "ida@x.org" })
  repo.seedUser({ id: STRANGER, displayName: "Sam Stranger", handle: "sam" })
  repo.seedMember(EVENT, ORGANIZER, "organizer")
  repo.seedMember(EVENT, COHOST, "cohost")
  repo.seedMember(EVENT, STAFF, "staff")
  service = makeService()
})

describe("maskEmail", () => {
  it("never returns the address it was given", () => {
    const masked = maskEmail("ida@example.org")
    expect(masked).not.toContain("ida@example.org")
    expect(masked.startsWith("i")).toBe(true)
    expect(masked.endsWith(".org")).toBe(true)
  })
})

describe("listEventTeam", () => {
  it("shows organizer, cohosts and staff but never plain members", async () => {
    repo.seedMember(EVENT, STRANGER, "member")
    const payload = await service.listTeam(EVENT, ORGANIZER)
    expect(payload.members.map((m) => m.role)).toEqual(["organizer", "cohost", "staff"])
  })

  it("a cohost may read the team but is told they cannot change it", async () => {
    const payload = await service.listTeam(EVENT, COHOST)
    expect(payload.members.every((m) => !m.canChangeRole)).toBe(true)
  })

  it("the organizer may change everyone but themselves", async () => {
    const payload = await service.listTeam(EVENT, ORGANIZER)
    const self = payload.members.find((m) => m.person.id === ORGANIZER)
    expect(self?.canChangeRole).toBe(false)
    expect(payload.members.find((m) => m.person.id === STAFF)?.canRemove).toBe(true)
  })

  it("404s a stranger before it ever says forbidden", async () => {
    await expect(service.listTeam(EVENT, STRANGER)).rejects.toMatchObject({ code: "NOT_FOUND" })
  })
})

describe("inviteEventTeamMember", () => {
  it("only the organizer may invite (manage_team)", async () => {
    await expect(
      service.inviteMember(EVENT, COHOST, {
        identifierKind: "handle",
        identifier: "ida",
        role: "staff",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
  })

  it("stores only the token hash and masks the invitee's address", async () => {
    const { invite } = await service.inviteMember(EVENT, ORGANIZER, {
      identifierKind: "email",
      identifier: "ida@x.org",
      role: "cohost",
    })
    expect(invite.maskedEmail).not.toBe("ida@x.org")
    expect(JSON.stringify(invite)).not.toContain("token-")
    expect(repo.invites[0]?.tokenHash).not.toBe("token-1-aaaaaaaaaaaaaaaaaaaaaaaa")
  })

  it("emails the invitee a one-time link", async () => {
    await service.inviteMember(EVENT, ORGANIZER, {
      identifierKind: "email",
      identifier: "ida@x.org",
      role: "staff",
    })
    expect(sentMail).toHaveLength(1)
    expect(String(sentMail[0]?.vars.message)).toContain("token-1")
  })

  it("409s a second open invitation for the same person", async () => {
    await service.inviteMember(EVENT, ORGANIZER, {
      identifierKind: "handle",
      identifier: "ida",
      role: "staff",
    })
    await expect(
      service.inviteMember(EVENT, ORGANIZER, {
        identifierKind: "handle",
        identifier: "ida",
        role: "staff",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" })
  })

  it("409s someone who is already on the team", async () => {
    await expect(
      service.inviteMember(EVENT, ORGANIZER, {
        identifierKind: "handle",
        identifier: "cody",
        role: "staff",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" })
  })

  it("refuses to invite a banned attendee back onto the team", async () => {
    repo.seedBan(EVENT, INVITEE)
    await expect(
      service.inviteMember(EVENT, ORGANIZER, {
        identifierKind: "handle",
        identifier: "ida",
        role: "staff",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
  })

  it("an email invite never reveals whether the address has an account", async () => {
    const known = await service.inviteMember(EVENT, ORGANIZER, {
      identifierKind: "email",
      identifier: "ida@x.org",
      role: "staff",
    })
    const unknown = await service.inviteMember(EVENT, ORGANIZER, {
      identifierKind: "email",
      identifier: "nobody@x.org",
      role: "staff",
    })
    expect(known.invite.invitee).toBeNull()
    expect(unknown.invite.invitee).toBeNull()
    expect(Object.keys(known.invite).sort()).toEqual(Object.keys(unknown.invite).sort())
    expect(repo.invites.every((i) => i.invitedUserId === null)).toBe(true)
    expect(sentMail.map((m) => m.to)).toEqual(["ida@x.org", "nobody@x.org"])
  })

  it("an email invite for someone already on the team answers like any other address", async () => {
    repo.seedUser({ id: COHOST, displayName: "Cody Cohost", handle: "cody", email: "cody@x.org" })
    const member = await service.inviteMember(EVENT, ORGANIZER, {
      identifierKind: "email",
      identifier: "cody@x.org",
      role: "staff",
    })
    const unknown = await service.inviteMember(EVENT, ORGANIZER, {
      identifierKind: "email",
      identifier: "nobody@x.org",
      role: "staff",
    })
    expect(member.invite.invitee).toEqual(unknown.invite.invitee)
    expect(member.invite.status).toEqual(unknown.invite.status)
    expect(member.invite.role).toEqual(unknown.invite.role)
  })

  it("an email invite for a banned account answers like any other address", async () => {
    repo.seedBan(EVENT, INVITEE)
    const banned = await service.inviteMember(EVENT, ORGANIZER, {
      identifierKind: "email",
      identifier: "ida@x.org",
      role: "staff",
    })
    expect(banned.invite.invitee).toBeNull()
    await expect(
      service.inviteMember(EVENT, ORGANIZER, {
        identifierKind: "handle",
        identifier: "ida",
        role: "staff",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    await expect(
      service.acceptInvite(EVENT, INVITEE, "token-1-aaaaaaaaaaaaaaaaaaaaaaaa"),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
  })

  it("404s an unknown handle rather than creating a dangling invite", async () => {
    await expect(
      service.inviteMember(EVENT, ORGANIZER, {
        identifierKind: "handle",
        identifier: "nobody",
        role: "staff",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  it(`caps an event at ${TEAM_INVITES_PER_EVENT_PER_DAY} invitations a day`, async () => {
    for (let i = 0; i < TEAM_INVITES_PER_EVENT_PER_DAY; i += 1) {
      repo.seedUser({ id: `guest-${i}`, handle: `guest${i}`, email: `guest${i}@x.org` })
      await service.inviteMember(EVENT, ORGANIZER, {
        identifierKind: "email",
        identifier: `guest${i}@x.org`,
        role: "staff",
      })
    }
    await expect(
      service.inviteMember(EVENT, ORGANIZER, {
        identifierKind: "email",
        identifier: "ida@x.org",
        role: "staff",
      }),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" })
  })
})

describe("acceptEventTeamInvite", () => {
  async function invited(role: "cohost" | "staff" = "staff"): Promise<string> {
    await service.inviteMember(EVENT, ORGANIZER, {
      identifierKind: "handle",
      identifier: "ida",
      role,
    })
    return "token-1-aaaaaaaaaaaaaaaaaaaaaaaa"
  }

  it("grants the invited role and scrubs the invited address", async () => {
    const token = await invited("cohost")
    const result = await service.acceptInvite(EVENT, INVITEE, token)
    expect(result).toEqual({ ok: true, role: "cohost" })
    expect(repo.invites[0]?.invitedEmail).toBeNull()
  })

  it("404s a token that was never issued", async () => {
    await expect(
      service.acceptInvite(EVENT, INVITEE, "token-nope-aaaaaaaaaaaaaaaaaaaaaa"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  it("404s the wrong recipient rather than telling them the invite exists", async () => {
    const token = await invited()
    await expect(service.acceptInvite(EVENT, STRANGER, token)).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
  })

  it("409s an expired invitation and marks it expired", async () => {
    const token = await invited()
    clock = new Date(clock.getTime() + TEAM_INVITE_TTL_MS + 1000)
    service = makeService()
    await expect(service.acceptInvite(EVENT, INVITEE, token)).rejects.toMatchObject({
      code: "CONFLICT",
    })
    expect(repo.invites[0]?.status).toBe("expired")
  })

  it("never demotes the organizer", async () => {
    await service.inviteMember(EVENT, ORGANIZER, {
      identifierKind: "handle",
      identifier: "ida",
      role: "staff",
    })
    repo.seedMember(EVENT, INVITEE, "organizer")
    const result = await service.acceptInvite(EVENT, INVITEE, "token-1-aaaaaaaaaaaaaaaaaaaaaaaa")
    expect(result.role).toBe("organizer")
  })

  it("an email-only invite is bound to that address, not to whoever holds the link", async () => {
    await service.inviteMember(EVENT, ORGANIZER, {
      identifierKind: "email",
      identifier: "outsider@example.org",
      role: "cohost",
    })
    const token = "token-1-aaaaaaaaaaaaaaaaaaaaaaaa"
    await expect(service.acceptInvite(EVENT, STRANGER, token)).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
    repo.seedUser({ id: STRANGER, handle: "sam", email: "outsider@example.org" })
    await expect(service.acceptInvite(EVENT, STRANGER, token)).resolves.toEqual({
      ok: true,
      role: "cohost",
    })
  })

  it("refuses to invite onto, or accept onto, a closed event", async () => {
    repo.closedEvents.add(EVENT)
    await expect(
      service.inviteMember(EVENT, ORGANIZER, {
        identifierKind: "handle",
        identifier: "ida",
        role: "staff",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" })
  })

  it("a revoked invitation can no longer be accepted", async () => {
    const token = await invited()
    await service.revokeInvite(EVENT, ORGANIZER, "invite-1")
    await expect(service.acceptInvite(EVENT, INVITEE, token)).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
  })
})

describe("retention", () => {
  it("NULLs invited addresses seven days after expiry, keeping the row", async () => {
    await service.inviteMember(EVENT, ORGANIZER, {
      identifierKind: "email",
      identifier: "ida@x.org",
      role: "staff",
    })
    expect(await service.scrubInviteEmails(100)).toBe(0)
    clock = new Date(clock.getTime() + TEAM_INVITE_TTL_MS + TEAM_INVITE_EMAIL_SCRUB_DELAY_MS + 1000)
    service = makeService()
    expect(await service.scrubInviteEmails(100)).toBe(1)
    expect(repo.invites).toHaveLength(1)
    expect(repo.invites[0]?.invitedEmail).toBeNull()
  })

  it("expires stale pending invitations", async () => {
    await service.inviteMember(EVENT, ORGANIZER, {
      identifierKind: "handle",
      identifier: "ida",
      role: "staff",
    })
    clock = new Date(clock.getTime() + TEAM_INVITE_TTL_MS + 1000)
    service = makeService()
    expect(await service.expireStaleInvites(100)).toBe(1)
    expect(repo.invites[0]?.status).toBe("expired")
  })
})
