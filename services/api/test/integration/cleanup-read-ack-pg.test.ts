import { TEST_TICKET_SIGNER } from "../helpers/ticket-signer.js"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import { FakePushSender } from "@civfix/shared/fakes"
import type { Container } from "../../src/di.js"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { InMemoryChatPresence } from "../../src/adapters/chat-presence.js"
import { InMemoryThreadsRepository } from "../helpers/chat.js"
import { InMemoryNotificationRepository } from "../helpers/notifications.js"
import {
  InMemoryBlocksRepository,
  InMemoryDmRepository,
} from "../../src/services/dm-repository.memory.js"
import {
  makeNotificationService,
  type NotificationService,
} from "../../src/services/notification-service.js"
import { makeDrizzleCleanupRepository } from "../../src/services/cleanup-repository.drizzle.js"
import { makeCleanupService } from "../../src/services/cleanup-service.js"
import { makeDrizzleChatRepository } from "../../src/services/chat-repository.drizzle.js"
import { makeDrizzleChatReadState } from "../../src/services/read-watermark-repository.drizzle.js"

type MarkRead = (cleanupId: string, userId: string, upToId: string) => Promise<void>

const { captured } = vi.hoisted(() => ({ captured: {} as { markRead?: MarkRead } }))

vi.mock("../../src/ws/gateway.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/ws/gateway.js")>()
  return {
    ...actual,
    registerChatGateway: (_app: unknown, opts: { markRead?: MarkRead }) => {
      captured.markRead = opts.markRead
    },
  }
})

const { wireChatGateway } = await import("../../src/routes/chat-gateway-wiring.js")

const pg = await withPg()

describe.skipIf(!pg)("F040: the cleanup read ack only advances on a message from THIS room", () => {
  let h: PgHarness
  let notifRepo: InMemoryNotificationRepository
  let notifications: NotificationService

  beforeAll(() => {
    h = pg as PgHarness
  })

  afterAll(async () => {
    await h.teardown()
  })

  async function newUser(name: string): Promise<string> {
    const [u] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name) VALUES (${name}) RETURNING id
    `
    return u!.id
  }

  async function newCleanup(organizerId: string, title: string): Promise<string> {
    const dto = await makeCleanupService({
      tickets: TEST_TICKET_SIGNER,
      repo: makeDrizzleCleanupRepository(h.sql),
    }).createCleanup(
      {
        title,
        type: "site",
        eventKind: "cleanup",
        lat: 34.05,
        lng: -118.25,
        scheduledAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        slots: [{ title: "General volunteers", capacity: null }],
      },
      organizerId,
    )
    return dto.id
  }

  function wire(): MarkRead {
    captured.markRead = undefined
    notifRepo = new InMemoryNotificationRepository()
    notifications = makeNotificationService({ repo: notifRepo, pushSender: new FakePushSender() })
    const blocks = new InMemoryBlocksRepository()
    const app = {
      chatOverrides: {
        isMember: () => Promise.resolve(true),
        threadsRepo: new InMemoryThreadsRepository(),
        readState: makeDrizzleChatReadState(h.sql),
        presence: new InMemoryChatPresence(),
        dmRepo: new InMemoryDmRepository((a, b) => blocks.isBlockedEitherWay(a, b)),
        blocksRepo: blocks,
        notificationService: notifications,
        conversationMutes: { isMuted: () => Promise.resolve(false) },
      },
      log: { warn: () => {}, error: () => {} },
    } as unknown as FastifyInstance
    const container = {
      env: { USE_FAKE_CHAT: false, WEB_ORIGINS: [] },
      storage: { presignGet: () => Promise.resolve("") },
      mailer: {},
      chatService: {},
      userChannel: {},
      getDb: () => ({ sql: h.sql }),
    } as unknown as Container

    wireChatGateway(app, container)
    expect(captured.markRead).toBeDefined()
    return captured.markRead!
  }

  function lastReadAt(cleanupId: string, userId: string): Promise<Date | null> {
    return makeDrizzleChatReadState(h.sql).lastReadAt(cleanupId, userId)
  }

  it("an ack naming a message from ANOTHER cleanup (or no message at all) leaves the watermark null", async () => {
    const member = await newUser("Ack Member")
    const room = await newCleanup(member, "Ack sweep")
    const otherRoom = await newCleanup(member, "Other sweep")
    const chatRepo = makeDrizzleChatRepository(h.sql)
    const foreign = await chatRepo.insertMessage(
      { cleanupId: otherRoom, userId: member, body: "elsewhere" },
      randomUUID(),
    )

    const markRead = wire()

    await markRead(room, member, foreign.id)
    expect(await lastReadAt(room, member)).toBeNull()

    await markRead(room, member, randomUUID())
    expect(await lastReadAt(room, member)).toBeNull()
  })

  it("an ack naming a message from THIS cleanup advances the watermark to that message", async () => {
    const member = await newUser("Ack Member 2")
    const room = await newCleanup(member, "Ack sweep 2")
    const chatRepo = makeDrizzleChatRepository(h.sql)
    const mine = await chatRepo.insertMessage(
      { cleanupId: room, userId: member, body: "here" },
      randomUUID(),
    )

    const markRead = wire()

    await markRead(room, member, mine.id)

    const at = await lastReadAt(room, member)
    expect(at?.getTime()).toBe(new Date(mine.createdAt).getTime())
  })

  it("a foreign ack does NOT roll the watermark back over an earlier real ack", async () => {
    const member = await newUser("Ack Member 3")
    const room = await newCleanup(member, "Ack sweep 3")
    const otherRoom = await newCleanup(member, "Other sweep 3")
    const chatRepo = makeDrizzleChatRepository(h.sql)
    const mine = await chatRepo.insertMessage(
      { cleanupId: room, userId: member, body: "here" },
      randomUUID(),
    )
    const foreign = await chatRepo.insertMessage(
      { cleanupId: otherRoom, userId: member, body: "elsewhere" },
      randomUUID(),
    )

    const markRead = wire()

    await markRead(room, member, mine.id)
    await markRead(room, member, foreign.id)

    const at = await lastReadAt(room, member)
    expect(at?.getTime()).toBe(new Date(mine.createdAt).getTime())
  })

  it("the bell still clears on a foreign ack (observed behavior, unchanged by F040)", async () => {
    const member = await newUser("Ack Member 4")
    const room = await newCleanup(member, "Ack sweep 4")
    const otherRoom = await newCleanup(member, "Other sweep 4")
    const chatRepo = makeDrizzleChatRepository(h.sql)
    const foreign = await chatRepo.insertMessage(
      { cleanupId: otherRoom, userId: member, body: "elsewhere" },
      randomUUID(),
    )

    const markRead = wire()
    await notifications.createNotification(member, {
      type: "cleanup_chat",
      title: "New message",
      body: "Someone posted in your cleanup.",
      link: `/cleanups/${room}`,
    })
    const unread = (): number =>
      notifRepo.notifications.filter(
        (n) => n.userId === member && n.type === "cleanup_chat" && n.readAt === null,
      ).length
    expect(unread()).toBe(1)

    await markRead(room, member, foreign.id)

    expect(unread()).toBe(0)
    expect(await lastReadAt(room, member)).toBeNull()
  })
})
