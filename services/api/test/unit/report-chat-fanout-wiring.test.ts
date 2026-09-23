import { describe, it, expect, beforeEach, vi } from "vitest"
import { FakePushSender } from "@civfix/shared/fakes"
import type { ChatMessageDTO } from "@civfix/shared"
import type { Container } from "../../src/di.js"

const stub = vi.hoisted(() => ({
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- the assertion is the field's declared type: vi.hoisted infers the record from this literal
  notifRepo: undefined as unknown,
  roster: [] as string[],
  limits: [] as (number | undefined)[],
  mutesFail: false,
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
      listMemberIds: (_reportId: string, limit?: number) => {
        stub.limits.push(limit)
        return Promise.resolve(stub.roster.slice(0, limit ?? actual.REPORT_CHAT_MEMBER_SCAN_CAP))
      },
      insertSystemMessage: (input: { reportId: string }) =>
        Promise.resolve(systemMessage(input.reportId)),
    }),
  }
})

vi.mock("../../src/services/conversation-mutes-repository.drizzle.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../src/services/conversation-mutes-repository.drizzle.js")
    >()
  const lookup = (): Promise<never> | undefined =>
    stub.mutesFail ? Promise.reject(new Error("mutes store down")) : undefined
  return {
    ...actual,
    makeConversationMutesRepository: () => ({
      isMuted: () => lookup() ?? Promise.resolve(false),
      setMuted: () => Promise.resolve(),
      mutedRoomIdsFor: () => Promise.resolve(new Set<string>()),
      mutedUserIdsFor: () => lookup() ?? Promise.resolve(new Set<string>()),
    }),
  }
})

const { makeContainerReportChatEmitter } = await import("../../src/services/report-chat-emitter.js")
const { makeContainerReportChatSendDeps } =
  await import("../../src/services/report-chat-send-wiring.js")
const { makeReportChatNotifier, REPORT_CHAT_FANOUT_MEMBER_CAP } =
  await import("../../src/services/report-chat-notifier.js")
const { makeNotificationService } = await import("../../src/services/notification-service.js")
const { InMemoryNotificationRepository } = await import("../helpers/notifications.js")

const REPORT = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
const ACTOR = "dddddddd-dddd-dddd-dddd-dddddddddddd"
const OVERSIZED_ROSTER = REPORT_CHAT_FANOUT_MEMBER_CAP + 100

let notifRepo: InstanceType<typeof InMemoryNotificationRepository>

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

function userMessage(): ChatMessageDTO {
  return {
    id: "66666666-6666-6666-6666-666666666666",
    cleanupId: REPORT,
    roomKind: "report",
    from: { id: ACTOR, name: "Dana", followers: 0, following: 0, isFollowing: false },
    body: "hello",
    kind: "text",
    reactions: [],
    mentions: [],
    createdAt: new Date().toISOString(),
  }
}

function rosterOf(n: number): string[] {
  return Array.from(
    { length: n },
    (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
  )
}

function containerFor(): Container {
  return {
    env: { USE_FAKE_CHAT: false },
    getDb: () => ({ sql: {} }),
    pushSender: new FakePushSender(),
    userChannel: undefined,
    chatService: { broadcast: () => Promise.resolve() },
    getBlocksRepo: () => ({ isBlockedEitherWay: () => Promise.resolve(false) }),
  } as unknown as Container
}

function reportBells(): number {
  return notifRepo.notifications.filter((n) => n.type === "report_chat").length
}

function warnLogger(): { warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> } {
  return { warn: vi.fn(), error: vi.fn() }
}

beforeEach(() => {
  notifRepo = new InMemoryNotificationRepository()
  stub.notifRepo = notifRepo
  stub.roster = rosterOf(OVERSIZED_ROSTER)
  stub.limits = []
  stub.mutesFail = false
})

describe("report-chat fan-out honours REPORT_CHAT_FANOUT_MEMBER_CAP on every wiring", () => {
  it("the admin send wiring scans and bells at most the report cap", async () => {
    const deps = makeContainerReportChatSendDeps(containerFor(), {
      chatRepo: () => {
        throw new Error("persist is not exercised here")
      },
    })

    await deps.notifyMembers!(REPORT, userMessage())

    expect(stub.limits).toEqual([REPORT_CHAT_FANOUT_MEMBER_CAP])
    expect(reportBells()).toBe(REPORT_CHAT_FANOUT_MEMBER_CAP)
  })

  it("the timeline emitter scans and bells at most the report cap", async () => {
    await makeContainerReportChatEmitter(containerFor()).emit({
      reportId: REPORT,
      status: "in_progress",
    })

    expect(stub.limits).toEqual([REPORT_CHAT_FANOUT_MEMBER_CAP])
    expect(reportBells()).toBe(REPORT_CHAT_FANOUT_MEMBER_CAP)
  })

  it("the notifier bounds the recipients even when an adapter drops the limit", async () => {
    const notify = makeReportChatNotifier({
      notificationService: makeNotificationService({
        repo: notifRepo,
        pushSender: new FakePushSender(),
      }),
      reportChatRepo: { listMemberIds: () => Promise.resolve(rosterOf(OVERSIZED_ROSTER)) },
      isMuted: () => Promise.resolve(false),
      roomKeyFor: (kind, id) => `${kind}:${id}`,
      isBlockedEitherWay: () => Promise.resolve(false),
    })

    await notify(REPORT, userMessage())

    expect(reportBells()).toBe(REPORT_CHAT_FANOUT_MEMBER_CAP)
  })
})

describe("a failed mute lookup notifies anyway and says so in the log", () => {
  beforeEach(() => {
    stub.roster = rosterOf(2)
    stub.mutesFail = true
  })

  it("admin send wiring", async () => {
    const logger = warnLogger()
    const deps = makeContainerReportChatSendDeps(containerFor(), {
      chatRepo: () => {
        throw new Error("persist is not exercised here")
      },
      logger: logger as never,
    })

    await deps.notifyMembers!(REPORT, userMessage())

    expect(reportBells()).toBe(2)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "report" }),
      expect.stringMatching(/mute lookup failed/),
    )
  })

  it("timeline emitter", async () => {
    const logger = warnLogger()

    await makeContainerReportChatEmitter(containerFor(), logger).emit({
      reportId: REPORT,
      status: "in_progress",
    })

    expect(reportBells()).toBe(2)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "report" }),
      expect.stringMatching(/mute lookup failed/),
    )
  })
})
