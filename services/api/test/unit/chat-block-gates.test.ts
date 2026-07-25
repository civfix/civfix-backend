import { describe, it, expect, vi } from "vitest"
import type { ChatMessageDTO } from "@civfix/shared"
import { makeReportChatNotifier } from "../../src/services/report-chat-notifier.js"
import { makeGroupChatNotifier } from "../../src/services/group-chat-notifier.js"
import { makeChatPowersResolver } from "../../src/services/chat-room-roles.js"

/**
 * Block-bypass regressions from the 2026-07-24 backend review:
 *
 *   M11 — the report-room and group-room notification fan-outs had NO block check (unlike the mention
 *         and reply bells in chat-bells), so a blocked user in a shared public room pushed a
 *         notification carrying their own name and a text preview to their target, per message.
 *   L10 — the chat-powers resolver's dm lane granted canPin to any participant without re-checking
 *         blocks, so a blocked user could pin/unpin in a thread they are cut off from, broadcasting
 *         each time.
 */

const ROOM = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
const ACTOR = "11111111-1111-1111-1111-111111111111"
const BLOCKED = "22222222-2222-2222-2222-222222222222"
const NEUTRAL = "33333333-3333-3333-3333-333333333333"

function message(): ChatMessageDTO {
  return {
    id: "msg-1",
    cleanupId: ROOM,
    from: { id: ACTOR, name: "Blocker McBlocked", avatar: { kind: "gradient", from: "#000", to: "#fff" } },
    body: "hello there",
    kind: "text",
    createdAt: new Date().toISOString(),
    reactions: [],
    mentions: [],
  } as unknown as ChatMessageDTO
}

function notificationSpy(): { createNotification: ReturnType<typeof vi.fn>; recipients: () => string[] } {
  const createNotification = vi.fn(() => Promise.resolve())
  return {
    createNotification,
    recipients: () =>
      createNotification.mock.calls.map((c) => (c as unknown as [string])[0]),
  }
}

describe("M11: the report-room fan-out skips blocked pairs", () => {
  const build = (isBlockedEitherWay: (a: string, b: string) => Promise<boolean>) => {
    const spy = notificationSpy()
    const notify = makeReportChatNotifier({
      notificationService: { createNotification: spy.createNotification } as never,
      reportChatRepo: { listMemberIds: () => Promise.resolve([ACTOR, BLOCKED, NEUTRAL]) },
      isMuted: () => Promise.resolve(false),
      roomKeyFor: (_k, id) => `report:${id}`,
      isBlockedEitherWay,
    })
    return { notify, spy }
  }

  it("does not bell a member blocked either way with the sender, but still bells everyone else", async () => {
    const { notify, spy } = build((a, b) =>
      Promise.resolve((a === ACTOR && b === BLOCKED) || (a === BLOCKED && b === ACTOR)),
    )
    await notify(ROOM, message())
    expect(spy.recipients()).toEqual([NEUTRAL])
  })

  it("FAILS CLOSED: a blocks-lookup error suppresses the bell rather than delivering it", async () => {
    const { notify, spy } = build(() => Promise.reject(new Error("db down")))
    await notify(ROOM, message())
    expect(spy.recipients()).toEqual([])
  })

  it("consults the blocks seam for EVERY candidate recipient (no recipient skips the gate)", async () => {
    const seen: Array<[string, string]> = []
    const { notify } = build((a, b) => {
      seen.push([a, b])
      return Promise.resolve(false)
    })
    await notify(ROOM, message())
    // Both non-sender members are checked, each against the message author.
    expect(seen).toEqual([
      [ACTOR, BLOCKED],
      [ACTOR, NEUTRAL],
    ])
  })

  /**
   * The dep is REQUIRED, not optional-with-a-fail-open-default. The first cut of M11 made it optional so
   * offline harnesses could omit it, and the poll fan-out (chat-poll-notifier) promptly did exactly that
   * — silently reproducing the bypass on the REST poll path with nothing in the type system to catch it.
   * This is a COMPILE-time assertion: `tsc --noEmit` covers test/, so if the dep ever goes back to
   * optional the @ts-expect-error below becomes an unused-suppression error and typecheck fails.
   */
  it("REQUIRED dep: a construction that omits the blocks seam does not typecheck", () => {
    const withoutBlocks = {
      notificationService: { createNotification: () => Promise.resolve() } as never,
      reportChatRepo: { listMemberIds: () => Promise.resolve([ACTOR]) },
      isMuted: () => Promise.resolve(false),
      roomKeyFor: (_k: "report", id: string) => `report:${id}`,
    }
    // @ts-expect-error isBlockedEitherWay is required — omitting it must never compile.
    expect(makeReportChatNotifier(withoutBlocks)).toBeTypeOf("function")

    const withoutBlocksGroup = {
      notificationService: { createNotification: () => Promise.resolve() } as never,
      groupRepo: { listMemberIds: () => Promise.resolve([ACTOR]) },
      isMuted: () => Promise.resolve(false),
      roomKeyFor: (_k: "group", id: string) => `group:${id}`,
    }
    // @ts-expect-error isBlockedEitherWay is required — omitting it must never compile.
    expect(makeGroupChatNotifier(withoutBlocksGroup)).toBeTypeOf("function")
  })

  it("an EXPLICIT no-blocks seam (offline harness) still bells everyone but the sender", async () => {
    // The old fail-open behaviour is still available — it just has to be asked for by name now.
    const { notify, spy } = build(() => Promise.resolve(false))
    await notify(ROOM, message())
    expect(spy.recipients().sort()).toEqual([BLOCKED, NEUTRAL].sort())
  })
})

describe("M11 batch seam: blockedIdsFor replaces the per-candidate gate, with the same stance", () => {
  const buildBatch = (blockedIdsFor: (a: string, ids: string[]) => Promise<Set<string>>) => {
    const spy = notificationSpy()
    const single = vi.fn(() => Promise.resolve(false))
    const notify = makeReportChatNotifier({
      notificationService: { createNotification: spy.createNotification } as never,
      reportChatRepo: { listMemberIds: () => Promise.resolve([ACTOR, BLOCKED, NEUTRAL]) },
      isMuted: () => Promise.resolve(false),
      roomKeyFor: (_k, id) => `report:${id}`,
      isBlockedEitherWay: single,
      blockedIdsFor,
    })
    return { notify, spy, single }
  }

  it("resolves the whole candidate set in ONE call and skips the per-candidate lookup", async () => {
    const seen: Array<[string, string[]]> = []
    const { notify, spy, single } = buildBatch((actorId, ids) => {
      seen.push([actorId, ids])
      return Promise.resolve(new Set(ids.filter((id) => id === BLOCKED)))
    })
    await notify(ROOM, message())
    expect(spy.recipients()).toEqual([NEUTRAL])
    // One query for both candidates (a 200-member room used to cost 200 round trips here)...
    expect(seen).toEqual([[ACTOR, [BLOCKED, NEUTRAL]]])
    // ...and the seam is authoritative: the per-candidate gate is not also run.
    expect(single).not.toHaveBeenCalled()
  })

  it("FAILS CLOSED on a batch error too: every candidate is treated as blocked", async () => {
    const { notify, spy } = buildBatch(() => Promise.reject(new Error("db down")))
    await notify(ROOM, message())
    expect(spy.recipients()).toEqual([])
  })
})

describe("M11: the group-room fan-out skips blocked pairs", () => {
  it("drops the blocked member and keeps the rest", async () => {
    const spy = notificationSpy()
    const notify = makeGroupChatNotifier({
      notificationService: { createNotification: spy.createNotification } as never,
      groupRepo: { listMemberIds: () => Promise.resolve([ACTOR, BLOCKED, NEUTRAL]) },
      isMuted: () => Promise.resolve(false),
      roomKeyFor: (_k, id) => `group:${id}`,
      isBlockedEitherWay: (_a, b) => Promise.resolve(b === BLOCKED),
    })
    await notify(ROOM, message())
    expect(spy.recipients()).toEqual([NEUTRAL])
  })
})

describe("L10: the dm lane's pin power respects blocks", () => {
  const deps = (over: Record<string, unknown> = {}) => ({
    isDmParticipant: () => Promise.resolve(true),
    cleanupRoleOf: () => Promise.reject(new Error("dm lane must not touch the cleanup lookup")),
    reportChatRoleOf: () => Promise.reject(new Error("dm lane must not touch the report lookup")),
    globalRoleOf: () => Promise.reject(new Error("dm lane must not touch the global role")),
    groupRoleOf: () => Promise.reject(new Error("dm lane must not touch the group lookup")),
    ...over,
  })

  it("a blocked participant holds NO powers in the thread", async () => {
    const resolve = makeChatPowersResolver(deps({ isDmBlocked: () => Promise.resolve(true) }) as never)
    expect(await resolve({ roomKind: "dm", roomId: ROOM, userId: ACTOR })).toEqual({
      canPin: false,
      canDeleteOthers: false,
      isModerator: false,
    })
  })

  it("an unblocked participant keeps canPin (and never canDeleteOthers)", async () => {
    const resolve = makeChatPowersResolver(deps({ isDmBlocked: () => Promise.resolve(false) }) as never)
    expect(await resolve({ roomKind: "dm", roomId: ROOM, userId: ACTOR })).toEqual({
      canPin: true,
      canDeleteOthers: false,
      isModerator: false,
    })
  })

  it("a non-participant is refused before the block lookup is even consulted", async () => {
    const isDmBlocked = vi.fn(() => Promise.resolve(false))
    const resolve = makeChatPowersResolver(
      deps({ isDmParticipant: () => Promise.resolve(false), isDmBlocked }) as never,
    )
    expect(await resolve({ roomKind: "dm", roomId: ROOM, userId: ACTOR })).toMatchObject({
      canPin: false,
    })
    expect(isDmBlocked).not.toHaveBeenCalled()
  })
})
