import { describe, expect, it, vi } from "vitest"
import { FakePushSender, FakeUserChannel } from "@civfix/shared/fakes"
import type { Container } from "../../src/di.js"
import { InMemoryCounterStore } from "../../src/abuse/counter-store.js"
import { InMemoryBlocksRepository } from "../../src/services/dm-repository.memory.js"
import { makeFakeSql, type FakeSqlControl } from "../helpers/fake-sql.js"
import { ROOM_FANOUT_THROTTLE_MS } from "../../src/services/chat-room-fanout-notifier.js"
import { REPORT_CHAT_FANOUT_MEMBER_CAP } from "../../src/services/report-chat-notifier.js"
import {
  ROOM_FANOUT_WINDOW_CLAIM_PREFIX,
  makeContainerRoomFanoutDeps,
  makeWindowClaim,
} from "../../src/services/chat-room-notifier-wiring.js"

interface Harness {
  container: Container
  fake: FakeSqlControl
  counters: InMemoryCounterStore
  redisOpened: number
}

function harness(opts: { useFakeChat?: boolean; usesRealRedis?: boolean } = {}): Harness {
  const fake = makeFakeSql()
  const counters = new InMemoryCounterStore()
  const state = { redisOpened: 0 }
  const container = {
    env: { USE_FAKE_CHAT: opts.useFakeChat ?? false },
    usesRealRedis: opts.usesRealRedis ?? false,
    pushSender: new FakePushSender(),
    userChannel: new FakeUserChannel(),
    getDb: () => ({ sql: fake.sql }),
    getBlocksRepo: () => new InMemoryBlocksRepository(),
    getCounterStore: () => counters,
    getRedis: () => {
      state.redisOpened += 1
      throw new Error("getRedis must not be called without a real redis")
    },
  } as unknown as Container
  return {
    container,
    fake,
    counters,
    get redisOpened() {
      return state.redisOpened
    },
  } as Harness
}

describe("makeContainerRoomFanoutDeps", () => {
  it("wires both fan-out kinds off one sql handle", () => {
    const h = harness()

    const deps = makeContainerRoomFanoutDeps(h.container)

    expect(Object.keys(deps).sort()).toEqual(["group", "report"])
    expect(typeof deps.report.listMemberIds).toBe("function")
    expect(typeof deps.group.listMemberIds).toBe("function")
    expect(h.fake.statements).toHaveLength(0)
  })

  it("opens NO redis connection while chat is faked or redis is absent, so wiring stays socket-free", () => {
    for (const opts of [
      { useFakeChat: true, usesRealRedis: true },
      { useFakeChat: false, usesRealRedis: false },
    ]) {
      const h = harness(opts)

      const deps = makeContainerRoomFanoutDeps(h.container)

      expect(h.redisOpened).toBe(0)
      expect(deps.report.presence).toBeUndefined()
      expect(deps.report.claimWindow).toBeUndefined()
      expect(deps.group.presence).toBeUndefined()
      expect(deps.group.claimWindow).toBeUndefined()
    }
  })

  it("caps the report fan-out member scan at REPORT_CHAT_FANOUT_MEMBER_CAP", async () => {
    const h = harness()

    await makeContainerRoomFanoutDeps(h.container).report.listMemberIds(
      "report-1",
      REPORT_CHAT_FANOUT_MEMBER_CAP,
    )

    const stmt = h.fake.statements[0]!
    expect(stmt.sql).toMatch(/FROM report_chat_members/)
    expect(stmt.sql).toMatch(/LIMIT \?/)
    expect(stmt.values).toEqual(["report-1", REPORT_CHAT_FANOUT_MEMBER_CAP])
  })

  it("scopes each kind's room key and mute lookup to that kind", async () => {
    const h = harness()
    const deps = makeContainerRoomFanoutDeps(h.container)

    expect(deps.report.roomKey("r1")).not.toBe(deps.group.roomKey("r1"))

    await deps.report.isMuted("u1", "r1")
    await deps.group.isMuted("u1", "r1")
    const [reportMute, groupMute] = h.fake.statements
    expect(reportMute!.values).toContain("report")
    expect(groupMute!.values).toContain("group")
  })

  it("treats a failed mute lookup as NOT muted so a Redis/DB blip cannot silence the room", async () => {
    const h = harness()
    const boom = makeFakeSql()
    const throwing = {
      ...h.container,
      getDb: () => ({
        sql: Object.assign(
          () => {
            throw new Error("db down")
          },
          { begin: boom.sql.begin, json: boom.sql.json },
        ),
      }),
    } as unknown as Container

    const deps = makeContainerRoomFanoutDeps(throwing)

    await expect(deps.report.isMuted("u1", "r1")).resolves.toBe(false)
  })
})

describe("makeWindowClaim", () => {
  function claimHarness(): {
    claim: ReturnType<typeof makeWindowClaim>
    counters: InMemoryCounterStore
  } {
    const counters = new InMemoryCounterStore()
    return { claim: makeWindowClaim({ getCounterStore: () => counters }), counters }
  }

  it("grants the window to the FIRST caller only", async () => {
    const { claim } = claimHarness()

    expect(await claim("report", "r1", 15_000)).toBe(true)
    expect(await claim("report", "r1", 15_000)).toBe(false)
    expect(await claim("report", "r1", 15_000)).toBe(false)
  })

  it("keys the claim by kind AND room, so two rooms never share a window", async () => {
    const { claim, counters } = claimHarness()
    const seen: string[] = []
    vi.spyOn(counters, "incr").mockImplementation((key: string) => {
      seen.push(key)
      return Promise.resolve(1)
    })

    await claim("report", "r1", 15_000)
    await claim("group", "r1", 15_000)

    expect(seen).toEqual([
      `${ROOM_FANOUT_WINDOW_CLAIM_PREFIX}:report:r1`,
      `${ROOM_FANOUT_WINDOW_CLAIM_PREFIX}:group:r1`,
    ])
  })

  it("rounds the TTL up to whole seconds and never below 1", async () => {
    const { claim, counters } = claimHarness()
    const ttls: number[] = []
    vi.spyOn(counters, "incr").mockImplementation((_key: string, ttl: number) => {
      ttls.push(ttl)
      return Promise.resolve(1)
    })

    await claim("report", "a", 15_000)
    await claim("report", "b", 1_200)
    await claim("report", "c", 10)

    expect(ttls).toEqual([15, 2, 1])
  })

  it("falls back to the default throttle window when the caller passes 0", async () => {
    const { claim, counters } = claimHarness()
    const ttls: number[] = []
    vi.spyOn(counters, "incr").mockImplementation((_key: string, ttl: number) => {
      ttls.push(ttl)
      return Promise.resolve(1)
    })

    await claim("report", "a", 0)

    expect(ttls).toEqual([Math.ceil(ROOM_FANOUT_THROTTLE_MS / 1000)])
  })

  it("fans out anyway (and warns) when the counter store is unavailable", async () => {
    const { claim, counters } = claimHarness()
    vi.spyOn(counters, "incr").mockRejectedValue(new Error("redis down"))
    const warn = vi.fn()
    const claimWithLog = makeWindowClaim({ getCounterStore: () => counters }, {
      warn,
      error: vi.fn(),
    } as never)

    expect(await claim("report", "r1", 15_000)).toBe(true)
    expect(await claimWithLog("report", "r1", 15_000)).toBe(true)
    expect(warn).toHaveBeenCalledOnce()
  })
})
