/**
 * makeContainerReportChatEmitter's optional BATCH seams (src/services/report-chat-emitter.ts).
 *
 * The emitter is assembled from container primitives (report-chat repo + notification service + mutes repo
 * + blocks repo) and fans a per-member bell for every timeline system message. The mutes batch seam it
 * wires is OPTIONAL on its repository, and chat-room-fanout-notifier treats a PRESENT batch seam as
 * AUTHORITATIVE: it then never runs the per-candidate gate. So binding an absent method through a
 * `?? Promise.resolve(new Set())` default (which is what this file used to do for mutes) silently turns the
 * gate OFF for the whole room: every muted member gets belled.
 *
 * These tests pin the probe-or-omit contract at this construction site:
 *   - mutes store WITH the batch form   -> one batched query, muted member suppressed;
 *   - mutes store WITHOUT it            -> per-user isMuted runs, muted member STILL suppressed;
 *   - the blocks repo is read LAZILY    -> the factory must not touch it (this emitter is built per event
 *     from minimal containers, and a factory throw escapes emit()'s own try/catch and takes the CALLER
 *     down with it; that is why the batch block seam is not probed here).
 *
 * Only the DB-bound factory leaves are mocked; the fan-out pipeline, the lane binder and the real
 * notification service all run, so the gates under test are the production ones.
 */

import { describe, it, expect, beforeEach, vi } from "vitest"
import { FakePushSender } from "@civfix/shared/fakes"
import type { ChatMessageDTO } from "@civfix/shared"
import type { Container } from "../../src/di.js"

const stub = vi.hoisted(() => ({
  notifRepo: undefined as unknown,
  members: [] as string[],
  /** `${roomKind}|${roomId}|${userId}` */
  muted: new Set<string>(),
  /** Whether the stubbed mutes repo implements the OPTIONAL batch member lookup. */
  batchMutes: true,
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
      listMemberIds: () => Promise.resolve([...stub.members]),
      insertSystemMessage: (input: { reportId: string; status: string }) =>
        Promise.resolve(systemMessage(input.reportId)),
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

const { makeContainerReportChatEmitter } = await import("../../src/services/report-chat-emitter.js")
const { InMemoryNotificationRepository } = await import("../helpers/notifications.js")

const REPORT = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
const A = "11111111-1111-1111-1111-111111111111"
const B = "22222222-2222-2222-2222-222222222222"

let notifRepo: InstanceType<typeof InMemoryNotificationRepository>

/** The sender-less `kind:"system"` DTO a timeline reflection produces. */
function systemMessage(reportId: string): ChatMessageDTO {
  return {
    id: "55555555-5555-5555-5555-555555555555",
    cleanupId: reportId,
    roomKind: "report",
    from: null,
    body: "Status changed to In progress",
    kind: "system",
    reactions: [],
    mentions: [],
    createdAt: new Date().toISOString(),
  } as unknown as ChatMessageDTO
}

beforeEach(() => {
  notifRepo = new InMemoryNotificationRepository()
  stub.notifRepo = notifRepo
  stub.members = []
  stub.muted = new Set()
  stub.batchMutes = true
  stub.calls = []
})

/** The container surface makeContainerReportChatEmitter reads. `blockedIdsAmong` is opt-in per test. */
function containerFor(opts: { batchBlocks?: string[] } = {}): Container {
  const blocksCalls = opts.batchBlocks
  return {
    env: { USE_FAKE_CHAT: false },
    getDb: () => ({ sql: {} }),
    pushSender: new FakePushSender(),
    userChannel: undefined,
    chatService: { broadcast: () => Promise.resolve() },
    getBlocksRepo: () => ({
      isBlockedEitherWay: () => {
        blocksCalls?.push("single")
        return Promise.resolve(false)
      },
      ...(blocksCalls
        ? {
            blockedIdsAmong: (_actorId: string, ids: string[]) => {
              blocksCalls.push(`batch:${ids.length}`)
              return Promise.resolve(new Set<string>())
            },
          }
        : {}),
    }),
  } as unknown as Container
}

function bells(userId: string): number {
  return notifRepo.notifications.filter((n) => n.userId === userId && n.type === "report_chat")
    .length
}

describe("makeContainerReportChatEmitter: the mute seam is probed, never defaulted to empty", () => {
  it("uses the batch lookup when the mutes store has one, and suppresses the muted member", async () => {
    stub.members = [A, B]
    stub.muted.add(`report|${REPORT}|${B}`)

    await makeContainerReportChatEmitter(containerFor()).emit({
      reportId: REPORT,
      status: "in_progress",
    })

    expect(bells(A)).toBe(1)
    expect(bells(B)).toBe(0)
    expect(stub.calls.filter((c) => c.startsWith("mutes."))).toEqual(["mutes.batch:report"])
  })

  it("STILL suppresses the muted member when the store has NO batch form (per-user fallback)", async () => {
    // The regression this pins: an `?? Promise.resolve(new Set())` fallback here made the fan-out believe
    // nobody had muted the room, so a member who muted a report got belled for every status change.
    stub.batchMutes = false
    stub.members = [A, B]
    stub.muted.add(`report|${REPORT}|${B}`)

    await makeContainerReportChatEmitter(containerFor()).emit({
      reportId: REPORT,
      status: "in_progress",
    })

    expect(bells(A)).toBe(1)
    expect(bells(B)).toBe(0)
    expect(stub.calls.filter((c) => c.startsWith("mutes."))).toEqual([
      "mutes.isMuted:report",
      "mutes.isMuted:report",
    ])
  })
})

describe("makeContainerReportChatEmitter: the block seam stays LAZY", () => {
  it("never touches the blocks repo: not at construction, not per event (sender-less system messages)", async () => {
    const blockCalls: string[] = []
    stub.members = [A, B]

    // A container with NO getBlocksRepo at all: constructing the emitter must not reach for it. Callers of
    // this factory (inbound mail correlation, autoforward/outreach jobs, the report + moderation routers)
    // build it PER EVENT off containers that are minimal in tests, and a throw in the factory escapes the
    // emit() try/catch; it aborted the caller's remaining work (e.g. flipping a mail thread to 'replied').
    const container = {
      env: { USE_FAKE_CHAT: false },
      getDb: () => ({ sql: {} }),
      pushSender: new FakePushSender(),
      userChannel: undefined,
      chatService: { broadcast: () => Promise.resolve() },
    } as unknown as Container

    const emitter = makeContainerReportChatEmitter(container)
    await emitter.emit({ reportId: REPORT, status: "in_progress" })

    // Both members belled: a sender-less message has no actor, so the gate short-circuits before either
    // the per-candidate or the batch shape is consulted.
    expect(bells(A)).toBe(1)
    expect(bells(B)).toBe(1)
    expect(blockCalls).toEqual([])
  })

  it("still gates on blocks if a timeline event ever carries an author (dep is wired, just lazy)", async () => {
    const blockCalls: string[] = []
    stub.members = [A, B]

    const emitter = makeContainerReportChatEmitter(containerFor({ batchBlocks: blockCalls }))
    await emitter.emit({ reportId: REPORT, status: "in_progress" })

    // Same no-actor short-circuit, so the lazily-resolved repo is never called for THIS event...
    expect(blockCalls).toEqual([])
    // ...but the dep is present, which is what keeps the path correct if a future event gains a sender.
    expect(bells(A)).toBe(1)
  })
})
