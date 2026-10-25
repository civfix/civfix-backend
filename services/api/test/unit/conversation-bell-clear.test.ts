import { describe, expect, it, vi } from "vitest"
import { randomUUID } from "node:crypto"
import { FakePushSender, FakeUserChannel } from "@civfix/seams"
import type { NotificationType } from "@civfix/contract"
import { makeNotificationService } from "../../src/services/notification-service.js"
import { clearConversationBellFor } from "../../src/services/conversation-bell.js"
import type { NotificationRecord } from "../../src/services/notification-repository.js"
import {
  InMemoryNotificationRepository,
  InMemoryNotificationSettingsRepository,
} from "../helpers/notifications.js"

/**
 * Clear-on-open: opening a room marks its bell rows and its chat_mention rows read, then sends one push
 * clear naming exactly those ids and one notifications signal, or nothing when no row changed.
 */

const A = randomUUID()
const R = new Date("2026-10-01T12:00:00.000Z")
const SIGNAL = { topic: "notifications" }

function setup() {
  const repo = new InMemoryNotificationRepository()
  const pushSender = new FakePushSender()
  const userChannel = new FakeUserChannel()
  const logger = { warn: vi.fn(), error: vi.fn() }
  const service = makeNotificationService({
    repo,
    settingsRepo: new InMemoryNotificationSettingsRepository(),
    pushSender,
    userChannel,
    logger,
  })

  async function row(
    type: NotificationType,
    link: string,
    readAt: Date | null = null,
  ): Promise<NotificationRecord> {
    const record = await repo.insertNotification({ userId: A, type, title: type, body: null, link })
    record.readAt = readAt
    return record
  }

  const readAtOf = (id: string) => repo.notifications.find((n) => n.id === id)!.readAt

  return { repo, pushSender, userChannel, logger, service, row, readAtOf }
}

describe("clearConversationBellFor", () => {
  it("T33: a group room clears its group_chat and chat_mention rows only", async () => {
    const t = setup()
    const G = randomUUID()
    const H = randomUUID()
    const g1 = await t.row("group_chat", `/messages/group/${G}`)
    const m1 = await t.row("chat_mention", `/messages/group/${G}`)
    const m2 = await t.row("chat_mention", `/messages/group/${H}`)
    const old = await t.row("group_chat", `/messages/group/${G}`, R)

    await clearConversationBellFor(t.service, "group", G, A)

    expect(t.readAtOf(g1.id)).not.toBeNull()
    expect(t.readAtOf(m1.id)).not.toBeNull()
    expect(t.readAtOf(m2.id)).toBeNull()
    expect(t.readAtOf(old.id)).toEqual(R)
    expect(t.pushSender.clears).toHaveLength(1)
    expect(t.pushSender.clears[0]!.userId).toBe(A)
    const target = t.pushSender.clears[0]!.target as { ids: string[] }
    expect([...target.ids].sort()).toEqual([g1.id, m1.id].sort())
    expect(t.userChannel.published).toEqual([{ userId: A, signal: SIGNAL }])
  })

  it("T34: a cleanup room leaves a cleanup_reminder on the same link unread", async () => {
    const t = setup()
    const C = randomUUID()
    const chat = await t.row("cleanup_chat", `/cleanups/${C}`)
    const mention = await t.row("chat_mention", `/cleanups/${C}`)
    const reminder = await t.row("cleanup_reminder", `/cleanups/${C}`)

    await clearConversationBellFor(t.service, "cleanup", C, A)

    expect(t.readAtOf(chat.id)).not.toBeNull()
    expect(t.readAtOf(mention.id)).not.toBeNull()
    expect(t.readAtOf(reminder.id)).toBeNull()
    expect(t.pushSender.clears).toHaveLength(1)
    const target = t.pushSender.clears[0]!.target as { ids: string[] }
    expect([...target.ids].sort()).toEqual([chat.id, mention.id].sort())
  })

  it("T35: a room with nothing unread sends nothing", async () => {
    const t = setup()
    await clearConversationBellFor(t.service, "report", randomUUID(), A)
    expect(t.pushSender.clears).toHaveLength(0)
    expect(t.userChannel.published).toHaveLength(0)
  })

  it("T37: a clear that rejects still resolves, keeps the change and warns once", async () => {
    const t = setup()
    t.pushSender.clear = () => Promise.reject(new Error("redis down"))
    const G = randomUUID()
    const g1 = await t.row("group_chat", `/messages/group/${G}`)

    await clearConversationBellFor(t.service, "group", G, A)

    expect(t.readAtOf(g1.id)).not.toBeNull()
    expect(t.logger.warn).toHaveBeenCalledTimes(1)
  })
})
