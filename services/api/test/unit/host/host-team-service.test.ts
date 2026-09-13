import { beforeEach, describe, expect, it } from "vitest"
import { AppError, MAX_TEAM_INVITES_PER_EVENT, type HostCapability } from "@civfix/shared"
import { can, NO_HOST_STANDING, type HostStanding } from "@civfix/shared/host"
import { InMemoryCounterStore } from "../../../src/abuse/counter-store.js"
import { hostForbiddenCopy } from "../../../src/services/host/authz.js"
import type { HostStandingResolution } from "../../../src/services/host/host-standing.js"
import { InMemoryHostTeamRepository } from "../../../src/services/host/host-team-repository.memory.js"
import { fakeCleanupDTO } from "../../helpers/host-team.js"
import {
  makeHostTeamService,
  maskEmail,
  TEAM_INVITES_PER_EVENT_PER_DAY,
  TEAM_INVITE_EMAIL_SCRUB_DELAY_MS,
  TEAM_INVITE_INBOX_LINK,
  TEAM_INVITE_TTL_MS,
  type HostTeamService,
} from "../../../src/services/host/host-team-service.js"
import type { CreateNotificationInput } from "../../../src/services/notification-service.js"

const EVENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const OTHER_EVENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const ORGANIZER = "11111111-1111-4111-8111-111111111111"
const COHOST = "22222222-2222-4222-8222-222222222222"
const STAFF = "33333333-3333-4333-8333-333333333333"
const INVITEE = "44444444-4444-4444-8444-444444444444"
const STRANGER = "55555555-5555-4555-8555-555555555555"

function inviteIdOf(seq: number): string {
  return `cccccccc-cccc-4ccc-8ccc-${String(seq).padStart(12, "0")}`
}

let repo: InMemoryHostTeamRepository
let service: HostTeamService
let clock: Date
let sentMail: { to: string; vars: Record<string, unknown> }[]
let bells: { userId: string; input: CreateNotificationInput }[]
let tokenSeq: number

const orgAdmins = new Set<string>()

function standingOf(cleanupId: string, userId: string): HostStanding {
  const role =
    repo.members.find((m) => m.cleanupId === cleanupId && m.userId === userId)?.role ?? null
  const orgRole = orgAdmins.has(userId) ? ("admin" as const) : null
  if (role === null && orgRole === null) return NO_HOST_STANDING
  return { eventRole: role, orgRole }
}

function seedOpenInvites(count: number, cleanupId: string = EVENT): void {
  for (let i = 0; i < count; i += 1) {
    repo.invites.push({
      id: inviteIdOf(900 + i),
      cleanupId,
      invitedUserId: null,
      invitedEmail: `filler${i}@x.org`,
      role: "staff",
      tokenHash: `filler-hash-${i}`,
      status: "pending",
      invitedBy: ORGANIZER,
      expiresAt: new Date(clock.getTime() + TEAM_INVITE_TTL_MS),
      acceptedAt: null,
      emailScrubbedAt: null,
      createdAt: clock,
    })
  }
}

function makeService(): HostTeamService {
  return makeHostTeamService({
    repo,
    standing: (cleanupId: string, userId: string, capability: HostCapability) => {
      const standing = standingOf(cleanupId, userId)
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
    loadEvent: (cleanupId: string) => Promise.resolve(fakeCleanupDTO(cleanupId)),
    notifier: {
      createNotification: (userId: string, input: CreateNotificationInput) => {
        bells.push({ userId, input })
        return Promise.resolve(null)
      },
    },
    eventTitleOf: () => Promise.resolve("Beach cleanup"),
    webOrigin: "https://civfix.test",
    now: () => clock,
    newToken: () => `token-${++tokenSeq}-aaaaaaaaaaaaaaaaaaaaaaaa`,
    newId: () => inviteIdOf(tokenSeq),
  })
}

beforeEach(() => {
  repo = new InMemoryHostTeamRepository()
  orgAdmins.clear()
  clock = new Date("2026-09-06T12:00:00.000Z")
  sentMail = []
  bells = []
  tokenSeq = 0
  repo.seedUser({
    id: ORGANIZER,
    displayName: "Olive Organizer",
    handle: "olive",
    avatarUrl: "https://cdn.civfix.test/olive.jpg",
  })
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

  it("carries each member's custom profile picture, and omits it when they have none", async () => {
    const payload = await service.listTeam(EVENT, ORGANIZER)
    const organizer = payload.members.find((m) => m.person.id === ORGANIZER)
    const staff = payload.members.find((m) => m.person.id === STAFF)
    expect(organizer?.person.avatarUrl).toBe("https://cdn.civfix.test/olive.jpg")
    expect(staff?.person).not.toHaveProperty("avatarUrl")
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

  it("emails the invitee a one-time link that carries the token in the URL FRAGMENT", async () => {
    await service.inviteMember(EVENT, ORGANIZER, {
      identifierKind: "email",
      identifier: "ida@x.org",
      role: "staff",
    })
    expect(sentMail).toHaveLength(1)
    const token = "token-1-aaaaaaaaaaaaaaaaaaaaaaaa"
    const message = String(sentMail[0]?.vars.message)
    expect(message).toContain(`https://civfix.test/cleanups/${EVENT}#teamInvite=${token}`)
    expect(message).not.toContain("?teamInvite=")
    const url = new URL(
      message.split(/\s+/).find((word) => word.startsWith("https://")) ?? "",
    )
    expect(url.hash).toBe(`#teamInvite=${token}`)
    expect(url.search).toBe("")
    expect(`${url.origin}${url.pathname}${url.search}`).not.toContain(token)
    expect(JSON.stringify(sentMail[0]?.vars)).not.toContain(`?teamInvite`)
  })

  it("re-inviting the same person returns the OPEN invite instead of 409ing", async () => {
    const first = await service.inviteMember(EVENT, ORGANIZER, {
      identifierKind: "handle",
      identifier: "ida",
      role: "staff",
    })
    const again = await service.inviteMember(EVENT, ORGANIZER, {
      identifierKind: "handle",
      identifier: "ida",
      role: "staff",
    })
    expect(again.invite.id).toBe(first.invite.id)
    expect(repo.invites.filter((i) => i.status === "pending")).toHaveLength(1)
  })

  it("re-inviting an open invitee at a DIFFERENT role updates that invite in place", async () => {
    const first = await service.inviteMember(EVENT, ORGANIZER, {
      identifierKind: "handle",
      identifier: "ida",
      role: "staff",
    })
    const again = await service.inviteMember(EVENT, ORGANIZER, {
      identifierKind: "handle",
      identifier: "ida",
      role: "cohost",
    })
    expect(again.invite.id).toBe(first.invite.id)
    expect(again.invite.role).toBe("cohost")
    expect(repo.invites.filter((i) => i.status === "pending")).toHaveLength(1)
    expect(sentMail).toHaveLength(1)
    expect(bells).toHaveLength(1)
    expect(repo.audits.at(-1)).toMatchObject({
      action: "event.team_role_changed",
      meta: { inviteId: first.invite.id, from: "staff", to: "cohost" },
    })
    await expect(service.acceptMyInvite(INVITEE, first.invite.id)).resolves.toMatchObject({
      role: "cohost",
    })
  })

  it("a repeat invitation spends neither the daily budget nor a seat under the open-invite cap", async () => {
    await service.inviteMember(EVENT, ORGANIZER, {
      identifierKind: "handle",
      identifier: "ida",
      role: "staff",
    })
    for (let i = 0; i < TEAM_INVITES_PER_EVENT_PER_DAY + 5; i += 1) {
      await service.inviteMember(EVENT, ORGANIZER, {
        identifierKind: "handle",
        identifier: "ida",
        role: "staff",
      })
    }
    expect(repo.invites.filter((i) => i.status === "pending")).toHaveLength(1)
    repo.seedUser({ id: "guest-a", handle: "guesta", email: "guesta@x.org" })
    await expect(
      service.inviteMember(EVENT, ORGANIZER, {
        identifierKind: "handle",
        identifier: "guesta",
        role: "staff",
      }),
    ).resolves.toMatchObject({ ok: true })
  })

  it(`returns the open invitation even at ${MAX_TEAM_INVITES_PER_EVENT} open invitations, which still bar a NEW one`, async () => {
    const first = await service.inviteMember(EVENT, ORGANIZER, {
      identifierKind: "handle",
      identifier: "ida",
      role: "staff",
    })
    seedOpenInvites(MAX_TEAM_INVITES_PER_EVENT - 1)
    expect(await repo.countPendingInvites(EVENT)).toBe(MAX_TEAM_INVITES_PER_EVENT)
    const again = await service.inviteMember(EVENT, ORGANIZER, {
      identifierKind: "handle",
      identifier: "ida",
      role: "staff",
    })
    expect(again.invite.id).toBe(first.invite.id)
    repo.seedUser({ id: "guest-b", handle: "guestb", email: "guestb@x.org" })
    await expect(
      service.inviteMember(EVENT, ORGANIZER, {
        identifierKind: "handle",
        identifier: "guestb",
        role: "staff",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" })
  })

  it("an idempotent re-invite sends no second email and rings no second bell", async () => {
    await service.inviteMember(EVENT, ORGANIZER, {
      identifierKind: "handle",
      identifier: "ida",
      role: "staff",
    })
    expect(sentMail).toHaveLength(1)
    expect(bells).toHaveLength(1)
    await service.inviteMember(EVENT, ORGANIZER, {
      identifierKind: "handle",
      identifier: "ida",
      role: "staff",
    })
    expect(sentMail).toHaveLength(1)
    expect(bells).toHaveLength(1)
  })

  it("rings an event_team_invite bell that deep-links to the home-feed inbox, never to the event or a manage screen", async () => {
    await service.inviteMember(EVENT, ORGANIZER, {
      identifierKind: "handle",
      identifier: "ida",
      role: "coordinator",
    })
    expect(bells).toEqual([
      {
        userId: INVITEE,
        input: {
          type: "event_team_invite",
          titleKey: "notification.event_team_invite.title",
          bodyKey: "notification.event_team_invite.body",
          vars: { title: "Beach cleanup" },
          varKeys: { role: "role.coordinator" },
          link: TEAM_INVITE_INBOX_LINK,
          push: "auto",
        },
      },
    ])
    expect(TEAM_INVITE_INBOX_LINK).toBe("/")
    expect(bells[0]?.input.link).not.toContain("/manage/")
    expect(bells[0]?.input.link).not.toContain("/cleanups/")
  })

  it("names the role by message key so de/es/ko never read the raw enum", async () => {
    for (const role of ["cohost", "coordinator", "staff"] as const) {
      bells = []
      repo.invites.length = 0
      await service.inviteMember(EVENT, ORGANIZER, {
        identifierKind: "handle",
        identifier: "ida",
        role,
      })
      expect(bells[0]?.input.varKeys).toEqual({ role: `role.${role}` })
      expect(JSON.stringify(bells[0]?.input.vars)).not.toContain(role)
    }
  })

  it("rings no bell for an email invite, which cannot name an account", async () => {
    await service.inviteMember(EVENT, ORGANIZER, {
      identifierKind: "email",
      identifier: "ida@x.org",
      role: "staff",
    })
    expect(bells).toHaveLength(0)
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

  it("0.43.0: an org admin seats nobody on the event team, in any role", async () => {
    orgAdmins.add(STRANGER)
    expect(can({ eventRole: null, orgRole: "admin" }, "manage_team")).toBe(false)
    for (const role of ["cohost", "coordinator", "staff"] as const) {
      await expect(
        service.inviteMember(EVENT, STRANGER, {
          identifierKind: "email",
          identifier: "ida@x.org",
          role,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" })
    }
    expect(repo.invites).toHaveLength(0)
  })

  it("refuses a self-invite by handle, so manage_team cannot mint the inviter a seat", async () => {
    repo.seedUser({ id: ORGANIZER, handle: "olive", email: "olive@x.org" })
    await expect(
      service.inviteMember(EVENT, ORGANIZER, {
        identifierKind: "handle",
        identifier: "olive",
        role: "cohost",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" })
    expect(repo.invites).toHaveLength(0)
  })

  it("refuses to let the inviter accept their own emailed invite", async () => {
    await service.inviteMember(EVENT, ORGANIZER, {
      identifierKind: "email",
      identifier: "olive@x.org",
      role: "cohost",
    })
    repo.seedUser({ id: ORGANIZER, handle: "olive", email: "olive@x.org" })
    await expect(
      service.acceptInvite(EVENT, ORGANIZER, "token-1-aaaaaaaaaaaaaaaaaaaaaaaa"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
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
    await service.revokeInvite(EVENT, ORGANIZER, inviteIdOf(1))
    await expect(service.acceptInvite(EVENT, INVITEE, token)).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
  })
})

describe("retention", () => {
  const scrubCutoff = () => new Date(clock.getTime() - TEAM_INVITE_EMAIL_SCRUB_DELAY_MS)

  it("NULLs invited addresses seven days after expiry, keeping the row", async () => {
    await service.inviteMember(EVENT, ORGANIZER, {
      identifierKind: "email",
      identifier: "ida@x.org",
      role: "staff",
    })
    expect(await repo.scrubInviteEmails(scrubCutoff(), 100)).toBe(0)
    clock = new Date(clock.getTime() + TEAM_INVITE_TTL_MS + TEAM_INVITE_EMAIL_SCRUB_DELAY_MS + 1000)
    expect(await repo.scrubInviteEmails(scrubCutoff(), 100)).toBe(1)
    expect(repo.invites).toHaveLength(1)
    expect(repo.invites[0]?.invitedEmail).toBeNull()
  })

  it("scrubs and expires the oldest invitations first when a batch is capped", async () => {
    seedOpenInvites(3)
    const [oldest, middle, newest] = repo.invites
    if (!oldest || !middle || !newest) throw new Error("fixture")
    oldest.expiresAt = new Date(clock.getTime() - 3000)
    middle.expiresAt = new Date(clock.getTime() - 2000)
    newest.expiresAt = new Date(clock.getTime() - 1000)
    expect(await repo.expireStaleInvites(clock, 1)).toBe(1)
    expect(oldest.status).toBe("expired")
    expect(middle.status).toBe("pending")
    expect(await repo.scrubInviteEmails(new Date(clock.getTime()), 1)).toBe(1)
    expect(oldest.invitedEmail).toBeNull()
    expect(middle.invitedEmail).not.toBeNull()
  })

  it("expires stale pending invitations", async () => {
    await service.inviteMember(EVENT, ORGANIZER, {
      identifierKind: "handle",
      identifier: "ida",
      role: "staff",
    })
    clock = new Date(clock.getTime() + TEAM_INVITE_TTL_MS + 1000)
    expect(await repo.expireStaleInvites(clock, 100)).toBe(1)
    expect(repo.invites[0]?.status).toBe("expired")
  })

  it("expires an invitation exactly ON its expiry instant, as accept already does", async () => {
    await service.inviteMember(EVENT, ORGANIZER, {
      identifierKind: "handle",
      identifier: "ida",
      role: "staff",
    })
    const expiresAt = repo.invites[0]?.expiresAt
    if (expiresAt === undefined) throw new Error("fixture")
    expect(await repo.expireStaleInvites(new Date(expiresAt.getTime() - 1), 100)).toBe(0)
    expect(repo.invites[0]?.status).toBe("pending")
    expect(await repo.expireStaleInvites(new Date(expiresAt.getTime()), 100)).toBe(1)
    expect(repo.invites[0]?.status).toBe("expired")
  })

  it("the boundary the sweep uses is the one accept uses", async () => {
    await service.inviteMember(EVENT, ORGANIZER, {
      identifierKind: "handle",
      identifier: "ida",
      role: "staff",
    })
    const expiresAt = repo.invites[0]?.expiresAt
    if (expiresAt === undefined) throw new Error("fixture")
    clock = new Date(expiresAt.getTime())
    service = makeService()
    await expect(service.acceptMyInvite(INVITEE, inviteIdOf(1))).rejects.toMatchObject({
      code: "CONFLICT",
    })
    expect(repo.invites[0]?.status).toBe("expired")
  })
})

describe("the coordinator tier", () => {
  it("seats a coordinator when the invitation is accepted", async () => {
    await service.inviteMember(EVENT, ORGANIZER, {
      identifierKind: "handle",
      identifier: "ida",
      role: "coordinator",
    })
    const result = await service.acceptInvite(
      EVENT,
      INVITEE,
      "token-1-aaaaaaaaaaaaaaaaaaaaaaaa",
    )
    expect(result).toEqual({ ok: true, role: "coordinator" })
  })

  it("never demotes a sitting cohost who accepts a coordinator invitation", async () => {
    await service.inviteMember(EVENT, ORGANIZER, {
      identifierKind: "handle",
      identifier: "ida",
      role: "coordinator",
    })
    repo.seedMember(EVENT, INVITEE, "cohost")
    const result = await service.acceptInvite(
      EVENT,
      INVITEE,
      "token-1-aaaaaaaaaaaaaaaaaaaaaaaa",
    )
    expect(result.role).toBe("cohost")
  })

  it("promotes a sitting staff member who accepts a coordinator invitation", async () => {
    await service.inviteMember(EVENT, ORGANIZER, {
      identifierKind: "handle",
      identifier: "ida",
      role: "coordinator",
    })
    repo.seedMember(EVENT, INVITEE, "staff")
    const result = await service.acceptInvite(
      EVENT,
      INVITEE,
      "token-1-aaaaaaaaaaaaaaaaaaaaaaaa",
    )
    expect(result.role).toBe("coordinator")
  })

  it("lists a coordinator on the team between the cohosts and the staff", async () => {
    repo.seedMember(EVENT, INVITEE, "coordinator")
    const payload = await service.listTeam(EVENT, ORGANIZER)
    expect(payload.members.map((m) => m.role)).toEqual([
      "organizer",
      "cohost",
      "coordinator",
      "staff",
    ])
  })

  it("lets a coordinator broadcast and read the team, and refuses export and event edits", async () => {
    repo.seedMember(EVENT, INVITEE, "coordinator")
    const standing = { eventRole: "coordinator" as const, orgRole: null }
    expect(can(standing, "broadcast")).toBe(true)
    expect(can(standing, "view_roster")).toBe(true)
    expect(can(standing, "check_in")).toBe(true)
    expect(can(standing, "moderate_chat")).toBe(true)
    expect(can(standing, "export")).toBe(false)
    expect(can(standing, "view_guest_contact")).toBe(false)
    expect(can(standing, "manage_event")).toBe(false)
    expect(can(standing, "manage_team")).toBe(false)
    const readable = await service.listTeam(EVENT, INVITEE)
    expect(readable.members.map((m) => m.role)).toContain("coordinator")
    expect(readable.members.every((m) => !m.canChangeRole && !m.canRemove)).toBe(true)
    await expect(
      service.inviteMember(EVENT, INVITEE, {
        identifierKind: "handle",
        identifier: "sam",
        role: "staff",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
  })
})

describe("listMyEventInvites", () => {
  async function inviteTo(userHandle: string, role: "cohost" | "staff" | "coordinator") {
    return service.inviteMember(EVENT, ORGANIZER, {
      identifierKind: "handle",
      identifier: userHandle,
      role,
    })
  }

  it("returns the viewer's open invitations with the event and the inviter, and no email", async () => {
    await inviteTo("ida", "coordinator")
    const page = await service.listMyInvites(INVITEE, {})
    expect(page.items).toHaveLength(1)
    const item = page.items[0]
    expect(item?.role).toBe("coordinator")
    expect(item?.event.id).toBe(EVENT)
    expect(item?.event.title).toBe("Beach cleanup")
    expect(item?.invitedBy?.id).toBe(ORGANIZER)
    expect(item).not.toHaveProperty("email")
    expect(JSON.stringify(item)).not.toContain("@")
  })

  it("never shows another person's invitation", async () => {
    await inviteTo("ida", "staff")
    await expect(service.listMyInvites(STRANGER, {})).resolves.toEqual({
      items: [],
      nextCursor: null,
    })
  })

  it("drops an invitation once it expires, is accepted, is declined or is revoked", async () => {
    await inviteTo("ida", "staff")
    expect((await service.listMyInvites(INVITEE, {})).items).toHaveLength(1)

    await service.declineMyInvite(INVITEE, inviteIdOf(1))
    expect((await service.listMyInvites(INVITEE, {})).items).toHaveLength(0)

    await inviteTo("ida", "staff")
    await service.revokeInvite(EVENT, ORGANIZER, inviteIdOf(2))
    expect((await service.listMyInvites(INVITEE, {})).items).toHaveLength(0)

    await inviteTo("ida", "staff")
    await service.acceptMyInvite(INVITEE, inviteIdOf(3))
    expect((await service.listMyInvites(INVITEE, {})).items).toHaveLength(0)

    repo.seedMember(EVENT, INVITEE, "member")
    await inviteTo("ida", "staff")
    clock = new Date(clock.getTime() + TEAM_INVITE_TTL_MS + 1000)
    service = makeService()
    expect((await service.listMyInvites(INVITEE, {})).items).toHaveLength(0)
  })

  it("pages with a keyset cursor", async () => {
    repo.seedMember(OTHER_EVENT, ORGANIZER, "organizer")
    const older = await inviteTo("ida", "staff")
    clock = new Date(clock.getTime() + 1000)
    service = makeService()
    const newer = await service.inviteMember(OTHER_EVENT, ORGANIZER, {
      identifierKind: "handle",
      identifier: "ida",
      role: "cohost",
    })
    expect(newer.invite.id).not.toBe(older.invite.id)

    const first = await service.listMyInvites(INVITEE, { limit: 1 })
    expect(first.items.map((i) => i.id)).toEqual([newer.invite.id])
    expect(first.nextCursor).not.toBeNull()

    const second = await service.listMyInvites(INVITEE, {
      limit: 1,
      cursor: first.nextCursor ?? "",
    })
    expect(second.items.map((i) => i.id)).toEqual([older.invite.id])
    expect(second.nextCursor).toBeNull()
  })

  it("never offers an invitation to an event that has closed since it was sent", async () => {
    await inviteTo("ida", "staff")
    expect((await service.listMyInvites(INVITEE, {})).items).toHaveLength(1)

    repo.closedEvents.add(EVENT)
    expect((await service.listMyInvites(INVITEE, {})).items).toHaveLength(0)

    repo.closedEvents.delete(EVENT)
    repo.seedEvent(EVENT, { status: "done" })
    expect((await service.listMyInvites(INVITEE, {})).items).toHaveLength(0)
  })
})

describe("acceptMyEventInvite / declineMyEventInvite", () => {
  async function invited(role: "cohost" | "staff" | "coordinator" = "coordinator") {
    await service.inviteMember(EVENT, ORGANIZER, {
      identifierKind: "handle",
      identifier: "ida",
      role,
    })
    return inviteIdOf(1)
  }

  it("seats the invited role and answers with the event as the viewer now sees it", async () => {
    const inviteId = await invited()
    const result = await service.acceptMyInvite(INVITEE, inviteId)
    expect(result.ok).toBe(true)
    expect(result.role).toBe("coordinator")
    expect(result.event.id).toBe(EVENT)
    expect(repo.invites[0]?.status).toBe("accepted")
    expect(repo.invites[0]?.invitedEmail).toBeNull()
  })

  it("a retried accept after a lost response answers 200 again, same role, one audit row", async () => {
    const inviteId = await invited()
    const first = await service.acceptMyInvite(INVITEE, inviteId)
    const seatings = repo.audits.filter((a) => a.action === "event.team_role_changed").length
    const retry = await service.acceptMyInvite(INVITEE, inviteId)
    expect(retry.ok).toBe(true)
    expect(retry.role).toBe(first.role)
    expect(retry.event.id).toBe(EVENT)
    expect(repo.audits.filter((a) => a.action === "event.team_role_changed")).toHaveLength(seatings)
  })

  it("409s a retried accept once the seat itself is gone", async () => {
    const inviteId = await invited()
    await service.acceptMyInvite(INVITEE, inviteId)
    repo.members.splice(
      repo.members.findIndex((m) => m.cleanupId === EVENT && m.userId === INVITEE),
      1,
    )
    await expect(service.acceptMyInvite(INVITEE, inviteId)).rejects.toMatchObject({
      code: "CONFLICT",
    })
  })

  it("reports the SEATED role, never a downgrade", async () => {
    const inviteId = await invited("staff")
    repo.seedMember(EVENT, INVITEE, "cohost")
    const result = await service.acceptMyInvite(INVITEE, inviteId)
    expect(result.role).toBe("cohost")
  })

  it("404s another person's invitation without saying it exists", async () => {
    const inviteId = await invited()
    await expect(service.acceptMyInvite(STRANGER, inviteId)).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
    await expect(service.declineMyInvite(STRANGER, inviteId)).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
    expect(repo.invites[0]?.status).toBe("pending")
  })

  it("declining is terminal, distinct from revoked, and frees a re-invite", async () => {
    const inviteId = await invited()
    await expect(service.declineMyInvite(INVITEE, inviteId)).resolves.toEqual({ ok: true })
    expect(repo.invites[0]?.status).toBe("declined")
    expect(repo.audits.at(-1)?.action).toBe("event.team_invite_declined")
    await expect(service.acceptMyInvite(INVITEE, inviteId)).rejects.toMatchObject({
      code: "CONFLICT",
    })
    const again = await service.inviteMember(EVENT, ORGANIZER, {
      identifierKind: "handle",
      identifier: "ida",
      role: "staff",
    })
    expect(again.invite.id).not.toBe(inviteId)
    expect(repo.invites.filter((i) => i.status === "pending")).toHaveLength(1)
  })

  it("409s an expired invitation and marks it expired", async () => {
    const inviteId = await invited()
    clock = new Date(clock.getTime() + TEAM_INVITE_TTL_MS + 1000)
    service = makeService()
    await expect(service.acceptMyInvite(INVITEE, inviteId)).rejects.toMatchObject({
      code: "CONFLICT",
    })
    expect(repo.invites[0]?.status).toBe("expired")
  })

  it("answers a settled invitation the same way on accept and on decline", async () => {
    const revoked = await invited()
    await service.revokeInvite(EVENT, ORGANIZER, revoked)
    await expect(service.acceptMyInvite(INVITEE, revoked)).rejects.toMatchObject({
      code: "CONFLICT",
    })
    await expect(service.declineMyInvite(INVITEE, revoked)).rejects.toMatchObject({
      code: "CONFLICT",
    })
  })

  it("409s a closed event and 403s a banned invitee", async () => {
    const inviteId = await invited()
    repo.closedEvents.add(EVENT)
    await expect(service.acceptMyInvite(INVITEE, inviteId)).rejects.toMatchObject({
      code: "CONFLICT",
    })
    repo.closedEvents.delete(EVENT)
    repo.seedBan(EVENT, INVITEE)
    await expect(service.acceptMyInvite(INVITEE, inviteId)).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
  })
})
