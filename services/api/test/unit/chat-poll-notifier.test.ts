/**
 * The POLL-CREATE member fan-out. makeContainerPollNotifier is the REST poll route's only bell path: it
 * assembles the same two lane notifiers the WS gateway wiring builds (report + group) out of container
 * primitives. Untested, it once shipped without the block gate (a poll create raises a member-wide push
 * carrying the author's name, so it needs the same gate as the message fan-out). This file pins the
 * module's whole contract:
 *
 *   - DISPATCH: report -> `report_chat` bells (/messages/report/:id), group -> `group_chat` bells
 *     (/messages/group/:id), cleanup -> NO fan-out at all (matching a plain cleanup send, which only
 *     bells @-mentions / reply targets) and no member scan either.
 *   - MUTE suppression, through the BATCH seam the module wires (mutedUserIdsFor), including that the
 *     lane's roomKind is carried into it: a mute on the group room must not silence the report room.
 *   - BLOCK suppression, in BOTH directions of the block edge.
 *   - The sender is never belled; a member's own poll doesn't ring their phone.
 *   - USE_FAKE_CHAT degrades to a no-op WITHOUT touching container.getDb().
 *
 * Only the DB-bound leaves are stubbed (the four repo factories the module calls with the container's sql
 * tag); the fan-out pipeline (chat-room-fanout-notifier), the lane binders, and the real notification
 * service all run for real, so the gates under test are the production ones.
 */

import { describe, it, expect, beforeEach, vi } from "vitest"
import { FakePushSender } from "@civfix/shared/fakes"
import type { ChatMessageDTO, PersonDTO } from "@civfix/shared"
import type { Container } from "../../src/di.js"

/**
 * Mock state. Held in a hoisted record because the vi.mock factories below are lifted above the imports;
 * each test rewrites the fields it cares about in beforeEach/inline.
 */
const stub = vi.hoisted(() => ({
  /** The InMemoryNotificationRepository instance, installed per test (see beforeEach). */
  notifRepo: undefined as unknown,
  reportMembers: [] as string[],
  groupMembers: [] as string[],
  /** `${roomKind}|${roomId}|${userId}` entries. */
  muted: new Set<string>(),
  /** Whether the stubbed mutes repo implements the OPTIONAL batch member lookup. */
  batchMutes: true,
  /** Every DB-bound leaf call, in order, so a test can assert a lane was never even scanned. */
  calls: [] as string[],
}))

vi.mock("../../src/services/notification-repository.drizzle.js", () => ({
  makeDrizzleNotificationRepository: () => stub.notifRepo,
}))

vi.mock("../../src/services/report-chat-repository.drizzle.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/services/report-chat-repository.drizzle.js")>()
  return {
    ...actual,
    makeReportChatRepository: () => ({
      listMemberIds: (reportId: string) => {
        stub.calls.push(`report.listMemberIds:${reportId}`)
        return Promise.resolve([...stub.reportMembers])
      },
    }),
  }
})

vi.mock("../../src/services/chat-group-repository.drizzle.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/services/chat-group-repository.drizzle.js")>()
  return {
    ...actual,
    makeChatGroupRepository: () => ({
      listMemberIds: (groupId: string) => {
        stub.calls.push(`group.listMemberIds:${groupId}`)
        return Promise.resolve([...stub.groupMembers])
      },
    }),
  }
})

vi.mock("../../src/services/conversation-mutes-repository.drizzle.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../src/services/conversation-mutes-repository.drizzle.js")
    >()
  return {
    ...actual,
    makeConversationMutesRepository: () => ({
      isMuted: (userId: string, roomKind: string, roomId: string) => {
        stub.calls.push(`mutes.isMuted:${roomKind}`)
        return Promise.resolve(stub.muted.has(`${roomKind}|${roomId}|${userId}`))
      },
      setMuted: () => Promise.resolve(),
      mutedRoomIdsFor: () => Promise.resolve(new Set<string>()),
      ...(stub.batchMutes
        ? {
            mutedUserIdsFor: (roomKind: string, roomId: string, userIds: string[]) => {
              stub.calls.push(`mutes.batch:${roomKind}`)
              return Promise.resolve(
                new Set(userIds.filter((u) => stub.muted.has(`${roomKind}|${roomId}|${u}`))),
              )
            },
          }
        : {}),
    }),
  }
})

const { makeContainerPollNotifier } = await import("../../src/services/chat-poll-notifier.js")
const { InMemoryNotificationRepository } = await import("../helpers/notifications.js")
const { InMemoryBlocksRepository } = await import("../../src/services/dm-repository.memory.js")

const ROOM = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
const A = "11111111-1111-1111-1111-111111111111"
const B = "22222222-2222-2222-2222-222222222222"
const C = "33333333-3333-3333-3333-333333333333"
const ACTOR = "44444444-4444-4444-4444-444444444444"

let notifRepo: InstanceType<typeof InMemoryNotificationRepository>
let blocks: InstanceType<typeof InMemoryBlocksRepository>

beforeEach(() => {
  notifRepo = new InMemoryNotificationRepository()
  blocks = new InMemoryBlocksRepository()
  stub.notifRepo = notifRepo
  stub.reportMembers = []
  stub.groupMembers = []
  stub.muted = new Set()
  stub.batchMutes = true
  stub.calls = []
  blockGateCalls = undefined
})

function person(id: string, name: string): PersonDTO {
  return { id, name, followers: 0, following: 0, isFollowing: false }
}

/** The DTO shape createPoll fans out: kind 'poll', the question in `body`, a hydrated `poll` payload. */
function pollMessage(
  roomKind: "cleanup" | "report" | "group",
  fromId: string | null,
  question = "Saturday or Sunday?",
): ChatMessageDTO {
  return {
    id: "55555555-5555-5555-5555-555555555555",
    cleanupId: ROOM,
    ...(roomKind === "cleanup" ? {} : { roomKind }),
    from: fromId === null ? null : person(fromId, "Dana"),
    body: question,
    kind: "poll",
    reactions: [],
    mentions: [],
    createdAt: new Date().toISOString(),
    poll: {
      question,
      allowMultiple: false,
      anonymous: false,
      closed: false,
      totalVoters: 0,
      myVote: [],
      options: [
        { idx: 0, text: "Sat", count: 0, mine: false },
        { idx: 1, text: "Sun", count: 0, mine: false },
      ],
    },
  } as ChatMessageDTO
}

/**
 * A container carrying only what makeContainerPollNotifier reads. `getDb` counts its calls so the
 * fake-chat case can prove the module never reached for a database.
 */
let getDbCalls = 0
function containerFor(useFakeChat = false): Container {
  getDbCalls = 0
  return {
    env: { USE_FAKE_CHAT: useFakeChat },
    getDb: () => {
      getDbCalls += 1
      return { sql: {} }
    },
    pushSender: new FakePushSender(),
    userChannel: undefined,
    getBlocksRepo: () => blocksRepoForContainer(),
  } as unknown as Container
}

/**
 * The block gate has two shapes: the required per-candidate `isBlockedEitherWay` and the OPTIONAL batch
 * `blockedIdsAmong` (one user_blocks query for the whole roster). Production's Drizzle repo implements
 * both; the in-memory repo implements only the first. `blockGateCalls`, when set, makes the container hand
 * out a repo carrying BOTH and records which shape the notifier actually used. The notifier treats a
 * present batch seam as authoritative, so "which one ran" is the thing worth pinning.
 */
let blockGateCalls: string[] | undefined

function blocksRepoForContainer(): InstanceType<typeof InMemoryBlocksRepository> {
  const calls = blockGateCalls
  if (calls === undefined) return blocks
  return {
    ...blocks,
    block: (a: string, b: string) => blocks.block(a, b),
    unblock: (a: string, b: string) => blocks.unblock(a, b),
    listBlocked: (a: string) => blocks.listBlocked(a),
    isBlockedEitherWay: (a: string, b: string) => {
      calls.push(`single:${b}`)
      return blocks.isBlockedEitherWay(a, b)
    },
    blockedIdsAmong: async (actorId: string, candidateIds: string[]) => {
      calls.push(`batch:${candidateIds.length}`)
      const verdicts = await Promise.all(
        candidateIds.map((id) => blocks.isBlockedEitherWay(actorId, id)),
      )
      return new Set(candidateIds.filter((_, i) => verdicts[i] === true))
    },
  } as unknown as InstanceType<typeof InMemoryBlocksRepository>
}

/** The notifier is fire-and-forget (returns void), so drain the task queues before asserting. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

function bells(userId: string, type: "report_chat" | "group_chat") {
  return notifRepo.notifications.filter((n) => n.userId === userId && n.type === type)
}

describe("makeContainerPollNotifier: report lane", () => {
  it("bells every other member with a report_chat notification linked to the report room", async () => {
    stub.reportMembers = [A, B, ACTOR]
    const notify = makeContainerPollNotifier(containerFor())

    notify("report", ROOM, pollMessage("report", ACTOR))
    await flush()

    expect(bells(A, "report_chat")).toHaveLength(1)
    expect(bells(B, "report_chat")).toHaveLength(1)
    // The author wrote it: never their own bell.
    expect(bells(ACTOR, "report_chat")).toHaveLength(0)

    const bell = bells(A, "report_chat")[0]!
    expect(bell.title).toBe("Dana")
    expect(bell.link).toBe(`/messages/report/${ROOM}`)
    // A poll is not a text message, so no preview leaks into the push body; the generic copy is used.
    expect(bell.body).toBe("Sent you a message")
  })

  it("falls back to the localized title for a poll with no author name", async () => {
    stub.reportMembers = [A, ACTOR]
    const notify = makeContainerPollNotifier(containerFor())

    notify("report", ROOM, { ...pollMessage("report", ACTOR), from: person(ACTOR, "  ") })
    await flush()

    expect(bells(A, "report_chat")[0]!.title).toBe("New message")
  })

  it("SUPPRESSES a member who muted this report room, via the batch mute lookup", async () => {
    stub.reportMembers = [A, B, ACTOR]
    stub.muted.add(`report|${ROOM}|${B}`)
    const notify = makeContainerPollNotifier(containerFor())

    notify("report", ROOM, pollMessage("report", ACTOR))
    await flush()

    expect(bells(A, "report_chat")).toHaveLength(1)
    expect(bells(B, "report_chat")).toHaveLength(0)
    // One query for the whole candidate set, scoped to THIS lane's room kind.
    expect(stub.calls.filter((c) => c.startsWith("mutes."))).toEqual(["mutes.batch:report"])
  })

  it("a mutes store WITHOUT the batch form still suppresses the muted member (per-user fallback)", async () => {
    // mutedUserIdsFor is OPTIONAL on ConversationMutesRepository. The fan-out treats a PRESENT batch seam
    // as authoritative and skips isMuted entirely, so binding an absent method through a
    // `?? Promise.resolve(new Set())` default unmuted the entire room. Absent must mean "omit the dep".
    stub.batchMutes = false
    stub.reportMembers = [A, B, ACTOR]
    stub.muted.add(`report|${ROOM}|${B}`)
    const notify = makeContainerPollNotifier(containerFor())

    notify("report", ROOM, pollMessage("report", ACTOR))
    await flush()

    expect(bells(A, "report_chat")).toHaveLength(1)
    expect(bells(B, "report_chat")).toHaveLength(0)
    // No batch call was possible; the per-candidate gate ran for each candidate instead.
    expect(stub.calls.filter((c) => c.startsWith("mutes."))).toEqual([
      "mutes.isMuted:report",
      "mutes.isMuted:report",
    ])
  })

  it("a mute on the GROUP room does NOT silence the report room (the lane's kind is carried through)", async () => {
    stub.reportMembers = [A, ACTOR]
    stub.muted.add(`group|${ROOM}|${A}`)
    const notify = makeContainerPollNotifier(containerFor())

    notify("report", ROOM, pollMessage("report", ACTOR))
    await flush()

    expect(bells(A, "report_chat")).toHaveLength(1)
  })

  it("SUPPRESSES a member blocked either way with the author (M11) and bells the rest", async () => {
    stub.reportMembers = [A, B, C, ACTOR]
    await blocks.block(ACTOR, B) // author blocked B
    await blocks.block(C, ACTOR) // C blocked the author
    const notify = makeContainerPollNotifier(containerFor())

    notify("report", ROOM, pollMessage("report", ACTOR))
    await flush()

    expect(bells(A, "report_chat")).toHaveLength(1)
    expect(bells(B, "report_chat")).toHaveLength(0)
    expect(bells(C, "report_chat")).toHaveLength(0)
  })
})

describe("makeContainerPollNotifier: group lane", () => {
  it("bells every other member with a group_chat notification linked to the group room", async () => {
    stub.groupMembers = [A, B, ACTOR]
    const notify = makeContainerPollNotifier(containerFor())

    notify("group", ROOM, pollMessage("group", ACTOR))
    await flush()

    expect(bells(A, "group_chat")).toHaveLength(1)
    expect(bells(B, "group_chat")).toHaveLength(1)
    expect(bells(ACTOR, "group_chat")).toHaveLength(0)
    expect(bells(A, "group_chat")[0]!.link).toBe(`/messages/group/${ROOM}`)
    // The group lane never scans the report roster.
    expect(stub.calls.some((c) => c.startsWith("report."))).toBe(false)
  })

  it("SUPPRESSES a member who muted this group room, scoped to roomKind 'group'", async () => {
    stub.groupMembers = [A, B, ACTOR]
    stub.muted.add(`group|${ROOM}|${A}`)
    const notify = makeContainerPollNotifier(containerFor())

    notify("group", ROOM, pollMessage("group", ACTOR))
    await flush()

    expect(bells(A, "group_chat")).toHaveLength(0)
    expect(bells(B, "group_chat")).toHaveLength(1)
    expect(stub.calls.filter((c) => c.startsWith("mutes."))).toEqual(["mutes.batch:group"])
  })

  it("SUPPRESSES a blocked member in the group lane too (M11)", async () => {
    stub.groupMembers = [A, B, ACTOR]
    await blocks.block(B, ACTOR)
    const notify = makeContainerPollNotifier(containerFor())

    notify("group", ROOM, pollMessage("group", ACTOR))
    await flush()

    expect(bells(A, "group_chat")).toHaveLength(1)
    expect(bells(B, "group_chat")).toHaveLength(0)
  })
})

describe("makeContainerPollNotifier: the M11 batch block seam", () => {
  it("uses blockedIdsAmong ONCE for the whole roster when the repo implements it", async () => {
    const calls: string[] = []
    blockGateCalls = calls
    stub.groupMembers = [A, B, C, ACTOR]
    await blocks.block(ACTOR, B) // author blocked B
    await blocks.block(C, ACTOR) // C blocked the author
    const notify = makeContainerPollNotifier(containerFor())

    notify("group", ROOM, pollMessage("group", ACTOR))
    await flush()

    // Same verdicts as the per-candidate path (both block directions suppressed, everyone else belled),
    expect(bells(A, "group_chat")).toHaveLength(1)
    expect(bells(B, "group_chat")).toHaveLength(0)
    expect(bells(C, "group_chat")).toHaveLength(0)
    // at one round trip for the three candidates instead of three, and the per-candidate gate is not
    // ALSO run (the batch seam is authoritative in chat-room-fanout-notifier).
    expect(calls).toEqual(["batch:3"])
  })

  it("falls back to the per-candidate gate when the repo has no batch form (never to 'nobody blocked')", async () => {
    // The in-memory repo (fake-chat + offline harnesses) implements only isBlockedEitherWay. Binding an
    // absent batch method through a `?? new Set()` default would have unblocked the whole room.
    stub.groupMembers = [A, B, ACTOR]
    await blocks.block(ACTOR, B)
    const notify = makeContainerPollNotifier(containerFor())

    notify("group", ROOM, pollMessage("group", ACTOR))
    await flush()

    expect(bells(A, "group_chat")).toHaveLength(1)
    expect(bells(B, "group_chat")).toHaveLength(0)
  })

  it("report lane wires the same batch seam", async () => {
    const calls: string[] = []
    blockGateCalls = calls
    stub.reportMembers = [A, B, ACTOR]
    await blocks.block(B, ACTOR)
    const notify = makeContainerPollNotifier(containerFor())

    notify("report", ROOM, pollMessage("report", ACTOR))
    await flush()

    expect(bells(A, "report_chat")).toHaveLength(1)
    expect(bells(B, "report_chat")).toHaveLength(0)
    expect(calls).toEqual(["batch:2"])
  })
})

describe("makeContainerPollNotifier: cleanup lane and fake-chat", () => {
  it("a CLEANUP poll bells NOBODY and never scans a member list", async () => {
    // Both rosters populated on purpose: if the dispatch leaked into either lane, these would ring.
    stub.reportMembers = [A, B, ACTOR]
    stub.groupMembers = [A, B, ACTOR]
    const notify = makeContainerPollNotifier(containerFor())

    notify("cleanup", ROOM, pollMessage("cleanup", ACTOR))
    await flush()

    expect(notifRepo.notifications).toHaveLength(0)
    expect(stub.calls).toEqual([])
  })

  it("USE_FAKE_CHAT returns a no-op notifier that never touches the database", async () => {
    stub.reportMembers = [A, B, ACTOR]
    const container = containerFor(true)
    const notify = makeContainerPollNotifier(container)

    notify("report", ROOM, pollMessage("report", ACTOR))
    notify("group", ROOM, pollMessage("group", ACTOR))
    await flush()

    expect(notifRepo.notifications).toHaveLength(0)
    expect(getDbCalls).toBe(0)
  })
})
