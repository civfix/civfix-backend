import { describe, it, expect } from "vitest"
import { AppError } from "@civfix/shared"
import type { Sql } from "../../src/db/client.js"
import { makeChatGroupService } from "../../src/services/chat-group-service.js"
import {
  makeChatGroupRepository,
  type ChatGroupRepository,
} from "../../src/services/chat-group-repository.drizzle.js"
import { makeFakeSql, type FakeSqlControl } from "../helpers/fake-sql.js"

const GROUP = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
const OWNER = "11111111-1111-1111-1111-111111111111"
const MEMBER = "22222222-2222-2222-2222-222222222222"

function recordingTransactions(fake: FakeSqlControl): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  const begin = fake.sql.begin
  fake.sql.begin = async (cb) => {
    const start = fake.statements.length
    const out = await begin(cb)
    ranges.push([start, fake.statements.length])
    return out
  }
  return ranges
}

function statementsIn(fake: FakeSqlControl, [start, end]: [number, number]): string[] {
  return fake.statements.slice(start, end).map((s) => s.sql.replace(/\s+/g, " ").trim())
}

describe("group kick repository writes", () => {
  it("removes the member and records the ban in one transaction", async () => {
    const fake = makeFakeSql()
    const txs = recordingTransactions(fake)

    await makeChatGroupRepository(fake.sql as unknown as Sql).banMember(GROUP, MEMBER, OWNER)

    expect(txs).toHaveLength(1)
    const inTx = statementsIn(fake, txs[0]!)
    expect(inTx.some((s) => /^DELETE FROM chat_group_members\b/.test(s))).toBe(true)
    expect(inTx.some((s) => /^INSERT INTO chat_group_bans\b/.test(s))).toBe(true)
    expect(fake.statements).toHaveLength(inTx.length)
  })

  it("self-join inserts only when no ban exists, in the same statement, and never clears a ban", async () => {
    const fake = makeFakeSql([
      { match: /INSERT INTO chat_group_members/, rows: [{ user_id: MEMBER }] },
    ])

    const joined = await makeChatGroupRepository(fake.sql as unknown as Sql).joinUnlessBanned(
      GROUP,
      MEMBER,
    )

    expect(joined).toBe(true)
    expect(fake.statements).toHaveLength(1)
    const sql = fake.statements[0]!.sql.replace(/\s+/g, " ")
    expect(sql).toMatch(/INSERT INTO chat_group_members/)
    expect(sql).toMatch(/NOT EXISTS \( SELECT 1 FROM chat_group_bans/)
    expect(sql).not.toMatch(/DELETE/)
  })
})

interface GroupState {
  members: Map<string, "owner" | "admin" | "member">
  bans: Set<string>
}

function statefulRepo(state: GroupState, opts: { banFails?: boolean } = {}): ChatGroupRepository {
  const view = {
    id: GROUP,
    kind: "group" as const,
    name: "Room",
    description: null,
    avatar: null,
    visibility: "public" as const,
    ownerId: OWNER,
    memberCount: 0,
    createdAt: new Date("2026-01-01T00:00:00Z"),
  }
  return {
    findById: () => Promise.resolve({ ...view, memberCount: state.members.size }),
    roleOf: (_g: string, userId: string) => Promise.resolve(state.members.get(userId) ?? null),
    isBanned: (_g: string, userId: string) => Promise.resolve(state.bans.has(userId)),
    removeMember: (_g: string, userId: string) => Promise.resolve(state.members.delete(userId)),
    banMember: (_g: string, userId: string) => {
      if (opts.banFails) return Promise.reject(new Error("db blip"))
      state.members.delete(userId)
      state.bans.add(userId)
      return Promise.resolve()
    },
    addMembers: (_g: string, userIds: string[]) => {
      for (const u of userIds) {
        if (!state.members.has(u)) state.members.set(u, "member")
        state.bans.delete(u)
      }
      return Promise.resolve()
    },
    joinUnlessBanned: (_g: string, userId: string) => {
      if (state.bans.has(userId) || state.members.has(userId)) return Promise.resolve(false)
      state.members.set(userId, "member")
      return Promise.resolve(true)
    },
    listMembers: () => Promise.resolve({ members: [], nextCursor: null }),
  } as unknown as ChatGroupRepository
}

describe("group kick service", () => {
  it("a failed ban write leaves the target a member instead of removed-but-unbanned", async () => {
    const state: GroupState = {
      members: new Map([
        [OWNER, "owner"],
        [MEMBER, "member"],
      ]),
      bans: new Set(),
    }
    const svc = makeChatGroupService({ groups: statefulRepo(state, { banFails: true }) })

    await expect(svc.removeMember(OWNER, GROUP, MEMBER)).rejects.toThrow("db blip")

    expect(state.members.has(MEMBER)).toBe(true)
  })

  it("a join whose checks ran before a kick committed does not re-add or unban the user", async () => {
    const state: GroupState = { members: new Map([[OWNER, "owner"]]), bans: new Set() }
    const repo = statefulRepo(state)
    const roleOf = repo.roleOf.bind(repo)
    repo.roleOf = async (groupId, userId) => {
      const role = await roleOf(groupId, userId)
      if (userId === MEMBER) state.bans.add(MEMBER)
      return role
    }
    const svc = makeChatGroupService({ groups: repo })

    let status: number | undefined
    try {
      await svc.joinGroup(MEMBER, GROUP)
    } catch (err) {
      if (err instanceof AppError) status = err.httpStatus
      else throw err
    }

    expect(status).toBe(403)
    expect(state.members.has(MEMBER)).toBe(false)
    expect(state.bans.has(MEMBER)).toBe(true)
  })
})
