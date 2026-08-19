import { describe, it, expect, vi } from "vitest"
import { AppError } from "@civfix/shared"
import { makeChatGroupService } from "../../src/services/chat-group-service.js"
import type { ChatGroupRepository } from "../../src/services/chat-group-repository.drizzle.js"


const GROUP = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
const OWNER = "11111111-1111-1111-1111-111111111111"
const MEMBER = "22222222-2222-2222-2222-222222222222"
const INVITEE_OK = "33333333-3333-3333-3333-333333333333"
const INVITEE_BLOCKED_BY_MEMBER = "44444444-4444-4444-4444-444444444444"
const STRANGER = "55555555-5555-5555-5555-555555555555"

interface FakeOpts {
  exists?: boolean
  visibility?: "public" | "private"
  roles?: Record<string, "owner" | "admin" | "member">
  members?: string[]
  blocked?: Array<[string, string]>
  banned?: string[]
}

type FakeRepo = ChatGroupRepository & {
  addMembers: ReturnType<typeof vi.fn>
  banMember: ReturnType<typeof vi.fn>
  bannedSet: Set<string>
}

function fakeRepo(opts: FakeOpts = {}): FakeRepo {
  const exists = opts.exists ?? true
  const visibility = opts.visibility ?? "private"
  const roles = opts.roles ?? { [OWNER]: "owner", [MEMBER]: "member" }
  const members = opts.members ?? [OWNER, MEMBER]
  const blocked = new Set((opts.blocked ?? []).flatMap(([a, b]) => [`${a}|${b}`, `${b}|${a}`]))
  const bannedSet = new Set<string>(opts.banned ?? [])
  const banMember = vi.fn((_g: string, userId: string) => {
    bannedSet.add(userId)
    return Promise.resolve()
  })
  const addMembers = vi.fn((_g: string, userIds: string[]) => {
    for (const u of userIds) bannedSet.delete(u)
    return Promise.resolve()
  })

  const view = {
    id: GROUP,
    kind: "group" as const,
    name: "Room",
    description: null,
    avatar: null,
    visibility,
    ownerId: OWNER,
    memberCount: members.length,
    createdAt: new Date("2026-01-01T00:00:00Z"),
  }

  return {
    findById: () => Promise.resolve(exists ? view : null),
    roleOf: (_g: string, userId: string) => Promise.resolve(exists ? (roles[userId] ?? null) : null),
    listMemberIds: () => Promise.resolve(members),
    invitableIdsOf: (actor: string, candidates: string[]) =>
      Promise.resolve(candidates.filter((c) => !blocked.has(`${actor}|${c}`))),
    blockedPairsAmong: (ids: string[]) => {
      const set = new Set<string>()
      for (const a of ids)
        for (const b of ids) if (a !== b && blocked.has(`${a}|${b}`)) set.add(`${a}|${b}`)
      return Promise.resolve(set)
    },
    addMembers,
    removeMember: () => Promise.resolve(true),
    banMember,
    isBanned: (_g: string, userId: string) => Promise.resolve(bannedSet.has(userId)),
    bannedSet,
    listMembers: () => Promise.resolve({ members: [], nextCursor: null }),
    findMediaIdByUploadId: () => Promise.resolve(null),
  } as unknown as FakeRepo
}

const svcOver = (repo: ChatGroupRepository): ReturnType<typeof makeChatGroupService> =>
  makeChatGroupService({ groups: repo })

async function statusOf(run: () => Promise<unknown>): Promise<{ status: number; code?: string }> {
  try {
    await run()
    return { status: 200 }
  } catch (err) {
    if (err instanceof AppError) {
      return { status: err.httpStatus, ...(err.fields?.code ? { code: String(err.fields.code) } : {}) }
    }
    throw err
  }
}

describe("M12: invitees blocked with an EXISTING member are silently skipped", () => {
  it("drops an invitee blocked either way with a current member, keeping the others", async () => {
    const repo = fakeRepo({ blocked: [[MEMBER, INVITEE_BLOCKED_BY_MEMBER]] })
    await svcOver(repo).addMembers(OWNER, {
      id: GROUP,
      memberIds: [INVITEE_OK, INVITEE_BLOCKED_BY_MEMBER],
    })
    expect(repo.addMembers).toHaveBeenCalledWith(GROUP, [INVITEE_OK])
  })

  it("still drops invitees blocked with the ACTOR (the pre-existing filter)", async () => {
    const repo = fakeRepo({ blocked: [[OWNER, INVITEE_BLOCKED_BY_MEMBER]] })
    await svcOver(repo).addMembers(OWNER, {
      id: GROUP,
      memberIds: [INVITEE_OK, INVITEE_BLOCKED_BY_MEMBER],
    })
    expect(repo.addMembers).toHaveBeenCalledWith(GROUP, [INVITEE_OK])
  })

  it("adds normally when nobody in the room is blocked with the invitees", async () => {
    const repo = fakeRepo()
    await svcOver(repo).addMembers(OWNER, { id: GROUP, memberIds: [INVITEE_OK] })
    expect(repo.addMembers).toHaveBeenCalledWith(GROUP, [INVITEE_OK])
  })
})

describe("addMembers reports the ACCEPTED invitees, independently of the members page", () => {
  it("returns `added` even when the first page shows none of them (pagination hides fresh members)", async () => {
    const repo = fakeRepo()
    const res = await svcOver(repo).addMembers(OWNER, { id: GROUP, memberIds: [INVITEE_OK] })
    expect(res.page.members).toEqual([])
    expect(res.added).toEqual([INVITEE_OK])
  })

  it("never reports an invitee the block filter dropped (M12) — they must learn nothing", async () => {
    const repo = fakeRepo({ blocked: [[MEMBER, INVITEE_BLOCKED_BY_MEMBER]] })
    const res = await svcOver(repo).addMembers(OWNER, {
      id: GROUP,
      memberIds: [INVITEE_OK, INVITEE_BLOCKED_BY_MEMBER],
    })
    expect(res.added).toEqual([INVITEE_OK])
    expect(res.added).not.toContain(INVITEE_BLOCKED_BY_MEMBER)
  })

  it("dedupes and drops self before reporting (the filter's own contract)", async () => {
    const repo = fakeRepo()
    const res = await svcOver(repo).addMembers(OWNER, {
      id: GROUP,
      memberIds: [INVITEE_OK, INVITEE_OK, OWNER],
    })
    expect(res.added).toEqual([INVITEE_OK])
  })
})

describe("L8: unknown group and no-access answer identically (no existence oracle)", () => {
  it("readable surface: unknown group and private non-member both 403 not_a_member", async () => {
    const unknown = await statusOf(() => svcOver(fakeRepo({ exists: false })).getGroup(STRANGER, GROUP))
    const priv = await statusOf(() => svcOver(fakeRepo()).getGroup(STRANGER, GROUP))
    expect(unknown).toEqual({ status: 403, code: "not_a_member" })
    expect(priv).toEqual(unknown)
  })

  it("update: unknown group and a powerless caller both 403 update_forbidden", async () => {
    const unknown = await statusOf(() =>
      svcOver(fakeRepo({ exists: false })).updateGroup(STRANGER, { id: GROUP, name: "x" }),
    )
    const powerless = await statusOf(() =>
      svcOver(fakeRepo()).updateGroup(STRANGER, { id: GROUP, name: "x" }),
    )
    expect(unknown).toEqual({ status: 403, code: "update_forbidden" })
    expect(powerless).toEqual(unknown)
  })

  it("addMembers: unknown group and a powerless caller both 403 add_members_forbidden", async () => {
    const unknown = await statusOf(() =>
      svcOver(fakeRepo({ exists: false })).addMembers(STRANGER, { id: GROUP, memberIds: [INVITEE_OK] }),
    )
    const powerless = await statusOf(() =>
      svcOver(fakeRepo()).addMembers(STRANGER, { id: GROUP, memberIds: [INVITEE_OK] }),
    )
    expect(unknown).toEqual({ status: 403, code: "add_members_forbidden" })
    expect(powerless).toEqual(unknown)
  })

  it("removeMember: unknown group and a powerless caller both 403 remove_forbidden", async () => {
    const unknown = await statusOf(() =>
      svcOver(fakeRepo({ exists: false })).removeMember(STRANGER, GROUP, MEMBER),
    )
    const powerless = await statusOf(() => svcOver(fakeRepo()).removeMember(STRANGER, GROUP, MEMBER))
    expect(unknown).toEqual({ status: 403, code: "remove_forbidden" })
    expect(powerless).toEqual(unknown)
  })

  it("setMemberRole: unknown group and a non-owner both 403 role_owner_only", async () => {
    const unknown = await statusOf(() =>
      svcOver(fakeRepo({ exists: false })).setMemberRole(STRANGER, GROUP, MEMBER, "admin"),
    )
    const nonOwner = await statusOf(() =>
      svcOver(fakeRepo()).setMemberRole(MEMBER, GROUP, OWNER, "admin"),
    )
    expect(unknown).toEqual({ status: 403, code: "role_owner_only" })
    expect(nonOwner).toEqual(unknown)
  })

  it("joinGroup: unknown group and a private group both 403 not_public", async () => {
    const unknown = await statusOf(() => svcOver(fakeRepo({ exists: false })).joinGroup(STRANGER, GROUP))
    const priv = await statusOf(() => svcOver(fakeRepo()).joinGroup(STRANGER, GROUP))
    expect(unknown).toEqual({ status: 403, code: "not_public" })
    expect(priv).toEqual(unknown)
  })

  it("a PUBLIC group stays readable pre-join (the gate did not over-tighten)", async () => {
    const repo = fakeRepo({ visibility: "public" })
    const dto = await svcOver(repo).getGroup(STRANGER, GROUP)
    expect(dto).toMatchObject({ id: GROUP, myRole: null, visibility: "public" })
  })

  it("a member still reads their own private group", async () => {
    const dto = await svcOver(fakeRepo()).getGroup(MEMBER, GROUP)
    expect(dto).toMatchObject({ id: GROUP, myRole: "member" })
  })
})

describe("F044 — group bans survive removal", () => {
  it("a moderation removal (actor !== target) writes a ban row", async () => {
    const repo = fakeRepo({ visibility: "public" })
    await svcOver(repo).removeMember(OWNER, GROUP, MEMBER)
    expect(repo.banMember).toHaveBeenCalledWith(GROUP, MEMBER, OWNER)
    expect(repo.bannedSet.has(MEMBER)).toBe(true)
  })

  it("a voluntary leave (actor === target) does NOT ban", async () => {
    const repo = fakeRepo({ visibility: "public" })
    await svcOver(repo).removeMember(MEMBER, GROUP, MEMBER)
    expect(repo.banMember).not.toHaveBeenCalled()
    expect(repo.bannedSet.has(MEMBER)).toBe(false)
  })

  it("a banned user can't re-join a public group — same 403 not_public, no oracle", async () => {
    const repo = fakeRepo({ visibility: "public", banned: [STRANGER] })
    const res = await statusOf(() => svcOver(repo).joinGroup(STRANGER, GROUP))
    expect(res).toEqual({ status: 403, code: "not_public" })
  })

  it("a non-banned user still joins a public group", async () => {
    const repo = fakeRepo({ visibility: "public" })
    const dto = await svcOver(repo).joinGroup(STRANGER, GROUP)
    expect(dto).toMatchObject({ id: GROUP, myRole: "member" })
  })

  it("an owner/admin re-invite clears the ban (unban path)", async () => {
    const repo = fakeRepo({ visibility: "public", banned: [INVITEE_OK] })
    await svcOver(repo).addMembers(OWNER, { id: GROUP, memberIds: [INVITEE_OK] })
    expect(repo.bannedSet.has(INVITEE_OK)).toBe(false)
  })
})

/**
 * F045: the invite gates used to issue ONE block-scan query per candidate (~100 per addMembers call).
 * They are two bulk reads now — the invitee/actor scan and the pairwise scan — whatever the roster size.
 */
describe("F045 — invite block scans are bulk, not per-candidate", () => {
  it("issues a constant number of block queries for a 40-invitee addMembers", async () => {
    const repo = fakeRepo()
    const invitable = vi.spyOn(repo, "invitableIdsOf")
    const pairwise = vi.spyOn(repo, "blockedPairsAmong")
    const invitees = Array.from(
      { length: 40 },
      (_, i) => `66666666-6666-6666-6666-6666666${String(i).padStart(5, "0")}`,
    )

    await svcOver(repo).addMembers(OWNER, { id: GROUP, memberIds: invitees })

    expect(repo.addMembers).toHaveBeenCalledWith(GROUP, invitees)
    expect(invitable).toHaveBeenCalledTimes(1)
    expect(invitable).toHaveBeenCalledWith(OWNER, invitees)
    expect(pairwise).toHaveBeenCalledTimes(1)
  })
})
