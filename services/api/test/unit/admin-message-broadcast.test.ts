// Operator removals must broadcast the tombstone like a member's own delete, or open clients keep
// rendering removed content until they refetch history.

import { describe, it, expect } from "vitest"
import type { ChatMessageDTO, RoomKind } from "@civfix/shared"
import { makeFakeSql } from "../helpers/fake-sql.js"
import type { Sql } from "../../src/db/client.js"
import {
  makeAdminReportChatService,
  makeMessageUpdateAnnouncer,
} from "../../src/services/admin/admin-report-chat-service.js"
import { findMessageRoom } from "../../src/services/admin/admin-report-chat-repository.drizzle.js"
import { InMemoryAdminReportChatRepository } from "../helpers/admin/admin-report-chat-repository.memory.js"
import { makeAdminUserService } from "../../src/services/admin/admin-user-service.js"
import { InMemoryAdminUserRepository } from "../helpers/admin/admin-user-repository.memory.js"
import { makeModerationService } from "../../src/services/admin/moderation-service.js"
import { InMemoryModerationRepository } from "../helpers/admin/moderation-repository.memory.js"
import type { ReportChatSendDeps } from "../../src/services/report-chat-send.js"

const REPORT_ID = "0b8f3a52-7a55-4d6e-9d0c-5a8f1b7c9e61"
const MESSAGE_ID = "0b8f3a52-7a55-4d6e-9d0c-5a8f1b7c9e62"
const USER_ID = "0b8f3a52-7a55-4d6e-9d0c-5a8f1b7c9e63"

interface Frame {
  kind: RoomKind
  roomId: string
  message: ChatMessageDTO
}

function tombstone(): ChatMessageDTO {
  return {
    id: MESSAGE_ID,
    mine: true,
    reactions: [{ emoji: "👍", count: 1, mine: true }],
    deletedAt: "2026-09-01T00:00:00.000Z",
  } as unknown as ChatMessageDTO
}

function recordingAnnouncer(): { announced: string[]; announce: (id: string) => Promise<void> } {
  const announced: string[] = []
  return {
    announced,
    announce: (id: string) => {
      announced.push(id)
      return Promise.resolve()
    },
  }
}

describe("makeMessageUpdateAnnouncer", () => {
  it("broadcasts the current message to its room with the viewer fields neutralized", async () => {
    const frames: Frame[] = []
    const announce = makeMessageUpdateAnnouncer({
      findRoom: () => Promise.resolve({ kind: "report", id: REPORT_ID }),
      loadMessage: () => Promise.resolve(tombstone()),
      broadcast: (kind, roomId, message) => frames.push({ kind, roomId, message }),
    })
    await announce(MESSAGE_ID)
    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatchObject({ kind: "report", roomId: REPORT_ID })
    expect(frames[0]?.message.mine).toBe(false)
    expect(frames[0]?.message.reactions?.[0]?.mine).toBe(false)
  })

  it("never fails the committed removal: a broadcast error is logged", async () => {
    const warned: unknown[] = []
    const announce = makeMessageUpdateAnnouncer({
      findRoom: () => Promise.reject(new Error("db down")),
      loadMessage: () => Promise.resolve(null),
      broadcast: () => undefined,
      logger: { warn: (obj: unknown) => warned.push(obj) },
    })
    await expect(announce(MESSAGE_ID)).resolves.toBeUndefined()
    expect(warned).toHaveLength(1)
  })
})

describe("findMessageRoom", () => {
  it("resolves a report chat message to its report room", async () => {
    const ctl = makeFakeSql([
      { match: /FROM chat_messages/, rows: [{ room_kind: "report", room_id: REPORT_ID }] },
    ])
    await expect(findMessageRoom(ctl.sql as unknown as Sql, MESSAGE_ID)).resolves.toEqual({
      kind: "report",
      id: REPORT_ID,
    })
    expect(ctl.statements[0]?.sql).toMatch(/FROM dm_messages/)
  })

  it("returns null for an unknown message", async () => {
    const ctl = makeFakeSql()
    await expect(findMessageRoom(ctl.sql as unknown as Sql, MESSAGE_ID)).resolves.toBeNull()
  })
})

describe("operator removals announce the tombstone", () => {
  it("report chat remove", async () => {
    const repo = new InMemoryAdminReportChatRepository()
    repo.seedReport(REPORT_ID)
    repo.seedMessage({ id: MESSAGE_ID, reportId: REPORT_ID })
    const rec = recordingAnnouncer()
    const svc = makeAdminReportChatService({
      repo,
      historySource: () => {
        throw new Error("unused")
      },
      send: {} as ReportChatSendDeps,
      announceMessageUpdate: rec.announce,
    })
    await svc.removeMessage(REPORT_ID, MESSAGE_ID, { reason: null, actorId: "op-1" })
    expect(rec.announced).toEqual([MESSAGE_ID])
    await expect(
      svc.removeMessage(REPORT_ID, MESSAGE_ID, { reason: null, actorId: "op-1" }),
    ).rejects.toThrow()
    expect(rec.announced).toEqual([MESSAGE_ID])
  })

  it("user message remove", async () => {
    const repo = new InMemoryAdminUserRepository()
    repo.seedMessage(USER_ID, {
      id: MESSAGE_ID,
      text: "hi",
      thread: "Cleanup",
      createdAt: new Date("2026-09-01T00:00:00.000Z"),
    })
    const rec = recordingAnnouncer()
    const svc = makeAdminUserService({
      repo,
      sessions: { applyStatus: () => Promise.resolve(0), revokeAll: () => Promise.resolve(0) },
      announceMessageUpdate: rec.announce,
    })
    await svc.removeMessage(USER_ID, MESSAGE_ID, { reason: null, actorId: "op-1" })
    expect(rec.announced).toEqual([MESSAGE_ID])
  })

  it("moderation remove and appeal overturn of a chat message", async () => {
    const repo = new InMemoryModerationRepository()
    const removal = repo.seedItem({ subjectType: "chat", subjectId: MESSAGE_ID })
    const appeal = repo.seedItem({ kind: "appeal", subjectType: "chat", subjectId: MESSAGE_ID })
    const rec = recordingAnnouncer()
    const svc = makeModerationService({ repo, announceMessageUpdate: rec.announce })
    await svc.remove(removal.id, { actorId: "op-1", reason: null })
    expect(rec.announced).toEqual([MESSAGE_ID])
    await svc.appeal(appeal.id, { decision: "overturn", actorId: "op-1", note: null })
    expect(rec.announced).toEqual([MESSAGE_ID, MESSAGE_ID])
  })

  it("an upheld appeal changes nothing and announces nothing", async () => {
    const repo = new InMemoryModerationRepository()
    const appeal = repo.seedItem({ kind: "appeal", subjectType: "message", subjectId: MESSAGE_ID })
    const rec = recordingAnnouncer()
    const svc = makeModerationService({ repo, announceMessageUpdate: rec.announce })
    await svc.appeal(appeal.id, { decision: "uphold", actorId: "op-1", note: null })
    expect(rec.announced).toEqual([])
  })
})
