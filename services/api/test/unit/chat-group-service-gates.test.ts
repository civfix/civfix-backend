import { describe, it, expect, vi } from "vitest"
import { AppError } from "@civfix/shared"
import { makeChatGroupService } from "../../src/services/chat-group-service.js"
import type { ChatGroupRepository } from "../../src/services/chat-group-repository.drizzle.js"

/**
 * Group-management gate regressions from the 2026-07-24 backend review:
 *
 *   M12 — addMembers is a unilateral INSERT with no consent step, and the invitee filter only excluded
 *         pairs blocked with the ACTOR. A third party could therefore force a blocked pair into the same
 *         room, repeatedly. The invitee filter now also drops anyone blocked either way with an EXISTING
 *         member of the target room.
 *   L8  — requireGroup threw 404 for an unknown group while requireReadable threw 403 for a private one,
 *         an existence oracle contradicting the WS lane's deliberately uniform 403.
 */

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
  /** Unordered blocked pairs, as "a|b". */
  blocked?: Array<[string, string]>
}

function fakeRepo(opts: FakeOpts = {}): ChatGroupRepository & { addMembers: ReturnType<typeof vi.fn> } {
  const exists = opts.exists ?? true
  const visibility = opts.visibility ?? "private"
  const roles = opts.roles ?? { [OWNER]: "owner", [MEMBER]: "member" }
  const members = opts.members ?? [OWNER, MEMBER]
  const blocked = new Set((opts.blocked ?? []).flatMap(([a, b]) => [`${a}|${b}`, `${b}|${a}`]))
  const addMembers = vi.fn(() => Promise.resolve())

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
    // The production query returns candidates that exist AND are not blocked either way with `actor`.
    invitableIdsOf: (actor: string, candidates: string[]) =>
      Promise.resolve(candidates.filter((c) => !blocked.has(`${actor}|${c}`))),
    addMembers,
    listMembers: () => Promise.resolve({ members: [], nextCursor: null }),
    findMediaIdByUploadId: () => Promise.resolve(null),
  } as unknown as ChatGroupRepository & { addMembers: ReturnType<typeof vi.fn> }
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
