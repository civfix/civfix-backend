import { describe, it, expect, vi, beforeEach } from "vitest"
import { FakePushSender } from "@civfix/shared/fakes"
import type { ChatMessageDTO } from "@civfix/shared"
import type { FastifyBaseLogger, FastifyInstance } from "fastify"
import type { Container } from "../../src/di.js"
import type { OnReportMessage } from "../../src/ws/types.js"
import type { ReportChatRepository } from "../../src/services/report-chat-repository.js"
import type { DiscussionReportView } from "../../src/services/discussion-repository.js"
import { InMemoryCounterStore } from "../../src/abuse/counter-store.js"
import { InMemoryChatPresence } from "../../src/adapters/chat-presence.js"
import { InMemoryChatReadState } from "../../src/services/threads-service.js"
import { makeNotificationService } from "../../src/services/notification-service.js"
import { InMemoryNotificationRepository } from "../helpers/notifications.js"
import { InMemoryThreadsRepository } from "../helpers/chat.js"
import {
  InMemoryBlocksRepository,
  InMemoryDmRepository,
} from "../../src/services/dm-repository.memory.js"

const { captured, mail } = vi.hoisted(() => ({
  captured: {} as { onReportMessage?: OnReportMessage },
  mail: { sendFails: false },
}))

vi.mock("../../src/ws/gateway.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/ws/gateway.js")>()
  return {
    ...actual,
    registerChatGateway: (_app: unknown, opts: { onReportMessage?: OnReportMessage }) => {
      captured.onReportMessage = opts.onReportMessage
    },
  }
})

vi.mock("../../src/services/discussion-repository.drizzle.js", () => ({
  makeDrizzleDiscussionRepository: () => ({
    findReportForDiscussion: (reportId: string): Promise<DiscussionReportView> =>
      Promise.resolve({
        id: reportId,
        reporterUserId: null,
        status: "published",
        visibility: "public",
        deletedAt: null,
        category: "graffiti",
        place: "San Francisco",
        jurisdiction: {
          geoid: "0600001",
          name: "City of San Francisco",
          handle: "sf",
          contactEmail: "fix@sf.gov",
        },
      }),
  }),
}))

vi.mock("../../src/services/admin/outbound-mail-service.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/services/admin/outbound-mail-service.js")>()
  return {
    ...actual,
    makeOutboundMailService: () => ({
      findReportThread: () =>
        Promise.resolve({ id: "thread-1", subject: "[civfix] Tag - SF - ABC123" }),
      appendOutbound: () =>
        mail.sendFails ? Promise.reject(new Error("smtp down")) : Promise.resolve({}),
    }),
  }
})

vi.mock("../../src/services/report-forward-audit-repository.drizzle.js", () => ({
  makeDrizzleReportForwardAuditRepository: () => ({
    recordMention: () => Promise.resolve(),
    markForwarded: () => Promise.resolve(),
  }),
}))

vi.mock("../../src/services/notification-repository.drizzle.js", () => ({
  makeDrizzleNotificationRepository: () => new InMemoryNotificationRepository(),
}))

const { wireChatGateway } = await import("../../src/routes/chat-gateway-wiring.js")
const { makeContainerReportChatSendDeps } =
  await import("../../src/services/report-chat-send-wiring.js")

const REPORT = "00000001-0000-0000-0000-000000000000"
const ACTOR = "11111111-1111-1111-1111-111111111111"

const MESSAGE = {
  id: "00000001-dddd-dddd-dddd-dddddddddddd",
  body: "please fix this @sf",
  createdAt: new Date("2026-07-09T12:00:00.000Z").toISOString(),
} as unknown as ChatMessageDTO

type WarnSpy = ReturnType<typeof vi.fn>

function spyLogger(): { warn: WarnSpy; error: WarnSpy; info: WarnSpy; debug: WarnSpy } {
  return { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }
}

function reportChatStub(): ReportChatRepository {
  const notImpl = (name: string) => () => {
    throw new Error(`fake reportChat.${name} not implemented`)
  }
  return {
    isMember: () => Promise.resolve(true),
    roleOf: notImpl("roleOf") as never,
    advanceReadWatermark: () => Promise.resolve(),
    markRead: notImpl("markRead") as never,
    join: notImpl("join") as never,
    leave: notImpl("leave") as never,
    insertSystemMessage: notImpl("insertSystemMessage") as never,
    listMemberIds: () => Promise.resolve([]),
    countMembers: notImpl("countMembers") as never,
    listMembers: notImpl("listMembers") as never,
  }
}

function containerWith(counters: InMemoryCounterStore): Container {
  return {
    env: {
      USE_FAKE_CHAT: false,
      WEB_ORIGINS: [],
      MAIL_FROM_OUTREACH: "a@b",
      MAIL_REPLY_DOMAIN: "b",
      REPORT_AUTOFORWARD_ENABLED: false,
    },
    storage: { presignGet: () => Promise.resolve("") },
    mailer: {},
    chatService: { broadcast: () => Promise.resolve() },
    userChannel: undefined,
    pushSender: new FakePushSender(),
    getDb: () => ({ sql: {} }),
    getCounterStore: () => counters,
    getBlocksRepo: () => new InMemoryBlocksRepository(),
  } as unknown as Container
}

function wireGateway(counters: InMemoryCounterStore, log: ReturnType<typeof spyLogger>) {
  const blocks = new InMemoryBlocksRepository()
  const app = {
    chatOverrides: {
      isMember: () => Promise.resolve(true),
      threadsRepo: new InMemoryThreadsRepository(),
      readState: new InMemoryChatReadState(),
      presence: new InMemoryChatPresence(),
      dmRepo: new InMemoryDmRepository((a, b) => blocks.isBlockedEitherWay(a, b)),
      blocksRepo: blocks,
      notificationService: makeNotificationService({
        repo: new InMemoryNotificationRepository(),
        pushSender: new FakePushSender(),
      }),
      reportChat: reportChatStub(),
      conversationMutes: { isMuted: () => Promise.resolve(false) },
    },
    log,
  } as unknown as FastifyInstance

  wireChatGateway(app, containerWith(counters))
  expect(captured.onReportMessage).toBeDefined()
  return captured.onReportMessage!
}

function warnedWith(log: ReturnType<typeof spyLogger>, msg: string): unknown[] {
  return log.warn.mock.calls.filter((call) => call[1] === msg).map((call) => call[0])
}

describe("the @city forwarder logs through the logger of the wiring that built it", () => {
  beforeEach(() => {
    captured.onReportMessage = undefined
    mail.sendFails = false
  })

  it("the chat gateway hands the server logger to the forwarder", async () => {
    const log = spyLogger()
    mail.sendFails = true
    const onReportMessage = wireGateway(new InMemoryCounterStore(), log)

    await onReportMessage(REPORT, MESSAGE, ACTOR)

    expect(warnedWith(log, "city forward send failed")).toEqual([
      expect.objectContaining({ reportId: REPORT, geoid: "0600001" }),
    ])
  })

  it("the chat gateway's forward throttle logs a counter outage through the server logger", async () => {
    const log = spyLogger()
    const broken = new InMemoryCounterStore()
    vi.spyOn(broken, "incr").mockRejectedValue(new Error("redis down"))
    const onReportMessage = wireGateway(broken, log)

    await onReportMessage(REPORT, MESSAGE, ACTOR)

    expect(warnedWith(log, "city forward throttle unavailable; forward skipped")).toEqual([
      expect.objectContaining({ reportId: REPORT, geoid: "0600001" }),
    ])
  })

  it("the admin report-chat send wiring hands its logger to the forwarder", async () => {
    const log = spyLogger()
    mail.sendFails = true
    const deps = makeContainerReportChatSendDeps(containerWith(new InMemoryCounterStore()), {
      chatRepo: () => {
        throw new Error("persist is not exercised here")
      },
      logger: log as unknown as FastifyBaseLogger,
    })

    await deps.forwardCityMention!(REPORT, MESSAGE, ACTOR)

    expect(warnedWith(log, "city forward send failed")).toEqual([
      expect.objectContaining({ reportId: REPORT, geoid: "0600001" }),
    ])
  })
})
