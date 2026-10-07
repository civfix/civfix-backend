import { describe, it, expect, vi } from "vitest"
import { randomUUID } from "node:crypto"
import type { UserMentionDTO } from "@civfix/shared"
import { makeChatEditService } from "../../src/services/chat-edit-service.js"
import { InMemoryChatRepository } from "../helpers/chat.js"

const ALICE = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
const BOB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
const REPORT = "cccccccc-cccc-cccc-cccc-cccccccccccc"
const BOB_MENTION: UserMentionDTO = { id: BOB, handle: "bob", displayName: "Bob" }

async function reportMessage(chat: InMemoryChatRepository, body: string): Promise<string> {
  const msg = await chat.insertMessage(
    { cleanupId: REPORT, roomKind: "report", userId: ALICE, body },
    randomUUID(),
  )
  return msg.id
}

function reportChat(): InMemoryChatRepository {
  const chat = new InMemoryChatRepository()
  chat.registerSender({ id: ALICE, displayName: "Alice", handle: "alice" })
  return chat
}

describe("editing a report-chat message re-records its mentions", () => {
  it("replaces the recorded set from the edited body, as the send path records it", async () => {
    const chat = reportChat()
    const messageId = await reportMessage(chat, "hello")
    const resolveKinds: string[] = []
    const recorded: { messageId: string; ids: string[] }[] = []
    const service = makeChatEditService({
      chat,
      isReportMember: () => Promise.resolve(true),
      chatMentions: {
        resolveChatMentions: (input) => {
          resolveKinds.push(input.kind)
          return Promise.resolve([BOB_MENTION])
        },
        recordChatMentions: (id, ids) => {
          recorded.push({ messageId: id, ids })
          return Promise.resolve()
        },
      },
    })

    await service.editMessage({
      roomKind: "report",
      roomId: REPORT,
      messageId,
      userId: ALICE,
      body: "hello @bob",
    })

    expect(resolveKinds).toEqual(["report"])
    expect(recorded).toEqual([{ messageId, ids: [BOB] }])
  })

  it("keeps the edit when mention re-recording fails, and logs the failure", async () => {
    const chat = reportChat()
    const messageId = await reportMessage(chat, "hello")
    const warn = vi.fn()
    const service = makeChatEditService({
      chat,
      isReportMember: () => Promise.resolve(true),
      chatMentions: {
        resolveChatMentions: () => Promise.resolve([BOB_MENTION]),
        recordChatMentions: () => Promise.reject(new Error("mention table unavailable")),
        logger: { warn },
      },
    })

    const updated = await service.editMessage({
      roomKind: "report",
      roomId: REPORT,
      messageId,
      userId: ALICE,
      body: "hello @bob",
    })

    expect(updated.body).toBe("hello @bob")
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ messageId, kind: "report", roomId: REPORT }),
      expect.stringMatching(/mention/),
    )
  })
})
