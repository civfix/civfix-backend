import { describe, it, expect, vi, beforeEach } from "vitest"
import { FakePushSender } from "@civfix/shared/fakes"
import type { ChatMessageDTO } from "@civfix/shared"
import type { FastifyInstance } from "fastify"
import type { Container } from "../../src/di.js"
import type { OnReportMessage } from "../../src/ws/types.js"
import type { ReportChatRepository } from "../../src/services/report-chat-repository.drizzle.js"
import type { DiscussionReportView } from "../../src/services/discussion-types.js"
import type {
  AppendOutboundInput,
  SendReportInput,
} from "../../src/services/admin/outbound-mail-service.js"
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
import {
  CITY_FORWARD_PER_SENDER_PER_HOUR,
  CITY_FORWARD_PER_GEOID_PER_HOUR,
} from "../../src/services/report-city-forward.js"

const { captured, sent } = vi.hoisted(() => ({
  captured: {} as { onReportMessage?: OnReportMessage },
  sent: [] as { threadId: string; input: AppendOutboundInput }[],
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
  const actual = await importOriginal<typeof import("../../src/services/admin/outbound-mail-service.js")>()
  return {
    ...actual,
    makeOutboundMailService: () => ({
      findReportThread: () =>
        Promise.resolve({ id: "thread-1", subject: "[civfix] Tag - SF - ABC123" }),
      prepareReportToJurisdiction: (_input: SendReportInput) =>
        Promise.resolve({
          thread: {},
          deliver: () => Promise.resolve({ thread: {}, messageId: "<stub@civfix.org>" }),
        }),
      sendReportToJurisdiction: (_input: SendReportInput) =>
        Promise.resolve({ thread: {}, messageId: "<stub@civfix.org>" }),
      appendOutbound: (threadId: string, input: AppendOutboundInput) => {
        sent.push({ threadId, input })
        return Promise.resolve({})
      },
    }),
  }
})

vi.mock("../../src/services/report-forward-audit.drizzle.js", () => ({
  makeReportForwardAudit: () => ({
    recordMention: () => Promise.resolve(),
    markForwarded: () => Promise.resolve(),
  }),
}))

const { wireChatGateway } = await import("../../src/routes/chat-gateway-wiring.js")

const ACTOR = "11111111-1111-1111-1111-111111111111"

function reportId(n: number): string {
  return `${String(n).padStart(8, "0")}-0000-0000-0000-000000000000`
}

function message(n: number): ChatMessageDTO {
  return {
    id: `${String(n).padStart(8, "0")}-dddd-dddd-dddd-dddddddddddd`,
    body: "please fix this @sf",
    createdAt: new Date("2026-07-09T12:00:00.000Z").toISOString(),
  } as unknown as ChatMessageDTO
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

function wire(counters: InMemoryCounterStore): OnReportMessage {
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
    log: { warn: () => {}, error: () => {} },
  } as unknown as FastifyInstance
  const container = {
    env: {
      USE_FAKE_CHAT: false,
      WEB_ORIGINS: [],
      MAIL_FROM_OUTREACH: "a@b",
      MAIL_REPLY_DOMAIN: "b",
      REPORT_AUTOFORWARD_ENABLED: false,
    },
    storage: { presignGet: () => Promise.resolve("") },
    mailer: {},
    chatService: {},
    userChannel: {},
    getDb: () => ({ sql: {} }),
    getCounterStore: () => counters,
  } as unknown as Container

  wireChatGateway(app, container)
  expect(captured.onReportMessage).toBeDefined()
  return captured.onReportMessage!
}

describe("chat-gateway-wiring: the LIVE @city forward gate is the durable throttle (F023)", () => {
  beforeEach(() => {
    sent.length = 0
    captured.onReportMessage = undefined
  })

  it("forwards an @city mention into the report's existing mail thread with REPORT_AUTOFORWARD_ENABLED off", async () => {
    const onReportMessage = wire(new InMemoryCounterStore())

    await onReportMessage(reportId(1), message(1), ACTOR)

    expect(sent).toHaveLength(1)
    expect(sent[0]!.threadId).toBe("thread-1")
    expect(sent[0]!.input.subject).toBe("Re: [civfix] Tag - SF - ABC123")
    expect(sent[0]!.input.kind).toBe("discussion")
    expect(sent[0]!.input.toAddr).toBe("fix@sf.gov")
  })

  it("caps one sender across DISTINCT reports — rotating report ids no longer buys a fresh email", async () => {
    const onReportMessage = wire(new InMemoryCounterStore())

    for (let i = 0; i < CITY_FORWARD_PER_SENDER_PER_HOUR + 5; i++) {
      await onReportMessage(reportId(i), message(i), ACTOR)
    }

    expect(sent).toHaveLength(CITY_FORWARD_PER_SENDER_PER_HOUR)
  })

  it("caps aggregate forwards into ONE jurisdiction across DISTINCT senders", async () => {
    const onReportMessage = wire(new InMemoryCounterStore())

    for (let i = 0; i < CITY_FORWARD_PER_GEOID_PER_HOUR + 5; i++) {
      await onReportMessage(reportId(i), message(i), `actor-${i}`)
    }

    expect(sent).toHaveLength(CITY_FORWARD_PER_GEOID_PER_HOUR)
  })

  it("dedups a repeat forward of the same (actor, report) and passes the actor through to the gate", async () => {
    const counters = new InMemoryCounterStore()
    const incr = vi.spyOn(counters, "incr")
    const onReportMessage = wire(counters)

    await onReportMessage(reportId(1), message(1), ACTOR)
    await onReportMessage(reportId(1), message(2), ACTOR)

    expect(sent).toHaveLength(1)
    const keys = incr.mock.calls.map((c) => c[0])
    expect(keys.some((k) => k.includes(ACTOR))).toBe(true)
    expect(keys).toContain(`citfwd:user:${ACTOR}`)
    expect(keys).toContain("citfwd:geoid:0600001")
  })

  it("FAILS CLOSED — no government email leaves when the shared counter store is down", async () => {
    const broken = new InMemoryCounterStore()
    vi.spyOn(broken, "incr").mockRejectedValue(new Error("redis down"))
    const onReportMessage = wire(broken)

    await onReportMessage(reportId(1), message(1), ACTOR)

    expect(sent).toHaveLength(0)
  })
})
