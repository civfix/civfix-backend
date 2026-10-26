/**
 * The timeline emitter (status changes, city replies, staff events) is a report fan-out of its own,
 * built outside the gateway, job and admin-send wirings, so it needs the conversation-name lookups
 * wired separately (D10: a report fan-out is named after the report's category label).
 *
 * Only the DB-bound factory leaves are mocked; the emitter, the fan-out and the name resolution run.
 */

import { describe, it, expect, beforeEach, vi } from "vitest"
import { FakePushSender } from "@civfix/seams"
import { REPORT_CATEGORY_LABELS } from "@civfix/contract"
import type { ChatMessageDTO, ReportCategory } from "@civfix/contract"
import type { Container } from "../../src/di.js"
import type { NotificationService } from "../../src/services/notification-service.js"

const stub = vi.hoisted(() => ({
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- the assertion is the field's declared type: vi.hoisted infers the record from this literal
  service: undefined as unknown,
  members: [] as string[],
  categories: new Map<string, string>(),
}))

vi.mock("../../src/services/route-notifier.js", () => ({
  makeRouteNotificationService: () => stub.service,
}))

vi.mock("../../src/services/report-chat-repository.drizzle.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/services/report-chat-repository.drizzle.js")>()
  return {
    ...actual,
    makeReportChatRepository: () => ({
      listMemberIds: () => Promise.resolve([...stub.members]),
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
  return {
    ...actual,
    makeConversationMutesRepository: () => ({
      isMuted: () => Promise.resolve(false),
      setMuted: () => Promise.resolve(),
      mutedRoomIdsFor: () => Promise.resolve(new Set<string>()),
      mutedUserIdsFor: () => Promise.resolve(new Set<string>()),
    }),
  }
})

vi.mock("../../src/services/conversation-name-repository.drizzle.js", () => ({
  makeConversationNameRepository: () => ({
    groupName: () => Promise.resolve(null),
    reportCategory: (reportId: string) =>
      Promise.resolve((stub.categories.get(reportId) as ReportCategory | undefined) ?? null),
    eventTitle: () => Promise.resolve(null),
  }),
}))

const { makeContainerReportChatEmitter } = await import("../../src/services/report-chat-emitter.js")
const { captureNotifications } = await import("../helpers/notification-capture.js")

const REPORT = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
const B = "22222222-2222-2222-2222-222222222222"

let n: ReturnType<typeof captureNotifications>

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

beforeEach(() => {
  n = captureNotifications()
  stub.service = n.service satisfies NotificationService
  stub.members = [B]
  stub.categories = new Map([[REPORT, "graffiti"]])
})

describe("makeContainerReportChatEmitter", () => {
  it("names a timeline message's fan-out after the report's category label", async () => {
    await makeContainerReportChatEmitter(containerFor()).emit({
      reportId: REPORT,
      status: "in_progress",
    })

    expect(n.inputs).toHaveLength(1)
    expect(n.inputs[0]?.userIds).toEqual([B])
    expect(n.inputs[0]?.input).toMatchObject({
      type: "report_chat",
      conversationName: REPORT_CATEGORY_LABELS.graffiti,
    })
  })
})
