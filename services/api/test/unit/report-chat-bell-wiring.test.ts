import { describe, it, expect, vi } from "vitest"
import { FakePushSender } from "@civfix/shared/fakes"
import type { FastifyInstance } from "fastify"
import type { Container } from "../../src/di.js"
import type { GatewayReportChat } from "../../src/ws/gateway.js"
import type { ReportChatRepository } from "../../src/services/report-chat-repository.drizzle.js"
import {
  makeNotificationService,
  type NotificationService,
} from "../../src/services/notification-service.js"
import { InMemoryNotificationRepository } from "../helpers/notifications.js"
import { InMemoryThreadsRepository } from "../helpers/chat.js"
import {
  InMemoryBlocksRepository,
  InMemoryDmRepository,
} from "../../src/services/dm-repository.memory.js"

const { captured } = vi.hoisted(() => ({ captured: {} as { reportChat?: GatewayReportChat } }))

vi.mock("../../src/ws/gateway.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/ws/gateway.js")>()
  return {
    ...actual,
    registerChatGateway: (_app: unknown, opts: { reportChat?: GatewayReportChat }) => {
      captured.reportChat = opts.reportChat
    },
  }
})

const { wireChatGateway, makeGatewayReportChat } = await import("../../src/routes/chat-gateway-wiring.js")

const REPORT = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
const BOB = "22222222-2222-2222-2222-222222222222"
const MSG = "44444444-4444-4444-4444-444444444444"

function makeReportChatSource(
  advanceReadWatermark: ReportChatRepository["advanceReadWatermark"],
): ReportChatRepository {
  const notImpl = (name: string) => () => {
    throw new Error(`fake reportChat.${name} not implemented`)
  }
  return {
    isMember: () => Promise.resolve(true),
    roleOf: notImpl("roleOf") as never,
    advanceReadWatermark,
    join: notImpl("join") as never,
    leave: notImpl("leave") as never,
    insertSystemMessage: notImpl("insertSystemMessage") as never,
    listMemberIds: notImpl("listMemberIds") as never,
    countMembers: notImpl("countMembers") as never,
  }
}

function wire(source: ReportChatRepository, notifications: NotificationService): void {
  const blocks = new InMemoryBlocksRepository()
  const overrides = {
    isMember: () => Promise.resolve(true),
    threadsRepo: new InMemoryThreadsRepository(),
    dmRepo: new InMemoryDmRepository((a, b) => blocks.isBlockedEitherWay(a, b)),
    blocksRepo: blocks,
    notificationService: notifications,
    reportChat: source,
  }
  const app = {
    chatOverrides: overrides,
    log: { warn: () => {} },
  } as unknown as FastifyInstance
  const container = {
    env: { USE_FAKE_CHAT: true, WEB_ORIGINS: [] },
    storage: { presignGet: () => Promise.resolve("") },
    chatService: {},
    userChannel: {},
  } as unknown as Container
  wireChatGateway(app, container)
}

describe("report chat bell wiring", () => {
  it("makeGatewayReportChat advances the watermark then clears the bell", async () => {
    const order: string[] = []
    const source = makeReportChatSource(async () => {
      order.push("advance")
    })
    const gateway = makeGatewayReportChat(source, async () => {
      order.push("clear")
    })

    await gateway.advanceReadWatermark(REPORT, BOB, MSG)

    expect(order).toEqual(["advance", "clear"])
  })

  it("the real wiring clears the report bell when a member reads (fails if the wiring drops the clear)", async () => {
    const advance = vi.fn((_reportId: string, _userId: string, _upToId: string) => Promise.resolve())
    const notifRepo = new InMemoryNotificationRepository()
    const notifications = makeNotificationService({ repo: notifRepo, pushSender: new FakePushSender() })

    wire(makeReportChatSource(advance), notifications)
    expect(captured.reportChat).toBeDefined()

    await notifications.createNotification(BOB, {
      type: "report_chat",
      title: "New message",
      body: "Someone replied on your report.",
      link: `/messages/report/${REPORT}`,
    })
    const unread = () =>
      notifRepo.notifications.filter(
        (n) => n.userId === BOB && n.type === "report_chat" && n.readAt === null,
      )
    expect(unread()).toHaveLength(1)

    await captured.reportChat!.advanceReadWatermark(REPORT, BOB, MSG)

    expect(advance).toHaveBeenCalledWith(REPORT, BOB, MSG)
    expect(unread()).toHaveLength(0)
  })
})
