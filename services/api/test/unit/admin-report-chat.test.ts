import { describe, expect, it } from "vitest"
import { AppError, type ChatHistoryPage, type ChatMessageDTO, type UserMentionDTO } from "@civfix/shared"
import type { PersistChatInput } from "@civfix/shared/interfaces"
import { makeAdminReportChatService } from "../../src/services/admin/admin-report-chat-service.js"
import { InMemoryAdminReportChatRepository } from "../../src/services/admin/admin-report-chat-repository.memory.js"
import { sendReportChatMessage, type ReportChatSendDeps } from "../../src/services/report-chat-send.js"
import { roomKeyFor } from "../../src/ws/gateway.js"

const REPORT_ID = "11111111-1111-1111-1111-111111111111"
const OPERATOR_ID = "99999999-9999-9999-9999-999999999999"
const MESSAGE_ID = "33333333-3333-3333-3333-333333333333"
const MEMBER_ID = "44444444-4444-4444-4444-444444444444"

function messageDTO(overrides: Partial<ChatMessageDTO> = {}): ChatMessageDTO {
  return {
    id: MESSAGE_ID,
    cleanupId: REPORT_ID,
    kind: "text",
    body: "Crew dispatched.",
    createdAt: "2026-09-21T12:00:00.000Z",
    mine: true,
    reactions: [],
    mentions: [],
    ...overrides,
  } as ChatMessageDTO
}

interface SendHarness {
  deps: ReportChatSendDeps
  persisted: PersistChatInput[]
  broadcasts: { roomKey: string; message: ChatMessageDTO }[]
  forwarded: { reportId: string; message: ChatMessageDTO; actorUserId: string }[]
  notified: { reportId: string; message: ChatMessageDTO }[]
  recorded: { messageId: string; mentionedUserIds: string[] }[]
  bells: { mentionedUserId: string; actorUserId: string }[]
  membershipChecks: string[]
}

function sendHarness(
  opts: { mentions?: UserMentionDTO[]; persistBody?: (input: PersistChatInput) => ChatMessageDTO } = {},
): SendHarness {
  const persisted: PersistChatInput[] = []
  const broadcasts: SendHarness["broadcasts"] = []
  const forwarded: SendHarness["forwarded"] = []
  const notified: SendHarness["notified"] = []
  const recorded: SendHarness["recorded"] = []
  const bells: SendHarness["bells"] = []
  const membershipChecks: string[] = []

  const deps: ReportChatSendDeps = {
    persist: (input) => {
      persisted.push(input)
      return Promise.resolve(
        opts.persistBody ? opts.persistBody(input) : messageDTO({ body: input.body }),
      )
    },
    broadcast: (roomKey, message) => {
      broadcasts.push({ roomKey, message })
      return Promise.resolve()
    },
    mentions: {
      resolveChatMentions: (input) => {
        membershipChecks.push(input.roomId)
        return Promise.resolve(opts.mentions ?? [])
      },
      recordChatMentions: (messageId, mentionedUserIds) => {
        recorded.push({ messageId, mentionedUserIds })
        return Promise.resolve()
      },
      notifyChatMention: (input) => {
        bells.push({ mentionedUserId: input.mentionedUserId, actorUserId: input.actorUserId })
        return Promise.resolve()
      },
    },
    notifyMembers: (reportId, message) => {
      notified.push({ reportId, message })
      return Promise.resolve()
    },
    forwardCityMention: (reportId, message, actorUserId) => {
      forwarded.push({ reportId, message, actorUserId })
      return Promise.resolve()
    },
  }
  return { deps, persisted, broadcasts, forwarded, notified, recorded, bells, membershipChecks }
}

function serviceHarness(
  opts: { pages?: ChatHistoryPage; pins?: ChatMessageDTO[]; send?: SendHarness } = {},
) {
  const repo = new InMemoryAdminReportChatRepository()
  const historyCalls: { reportId: string; viewerUserId: string | null; limit: number }[] = []
  const send = opts.send ?? sendHarness()
  const svc = makeAdminReportChatService({
    repo,
    historySource: (reportId, viewerUserId) => ({
      history: (_before, limit) => {
        historyCalls.push({ reportId, viewerUserId, limit })
        return Promise.resolve(opts.pages ?? { items: [messageDTO()], nextCursor: null })
      },
      listPins: () => Promise.resolve(opts.pins ?? []),
    }),
    send: send.deps,
  })
  return { svc, repo, historyCalls, send }
}

describe("admin report chat history (operator plane has NO public-visibility gate)", () => {
  it("returns chat history for a report in any status, including held and removed", async () => {
    const h = serviceHarness()
    h.repo.seedReport(REPORT_ID)

    const payload = await h.svc.history(REPORT_ID, { id: REPORT_ID }, OPERATOR_ID)

    expect(payload.items).toHaveLength(1)
    expect(h.historyCalls).toHaveLength(1)
    expect(h.historyCalls[0]?.reportId).toBe(REPORT_ID)
  })

  it("404s ONLY when the report row does not exist", async () => {
    const h = serviceHarness()

    await expect(h.svc.history(REPORT_ID, { id: REPORT_ID }, OPERATOR_ID)).rejects.toBeInstanceOf(
      AppError,
    )
    expect(h.historyCalls).toHaveLength(0)
  })

  it("passes the operator as the viewer so viewer-scoped fields resolve for them", async () => {
    const h = serviceHarness()
    h.repo.seedReport(REPORT_ID)

    await h.svc.history(REPORT_ID, { id: REPORT_ID }, OPERATOR_ID)

    expect(h.historyCalls[0]?.viewerUserId).toBe(OPERATOR_ID)
  })

  it("clamps the page limit and honors an explicit one", async () => {
    const h = serviceHarness()
    h.repo.seedReport(REPORT_ID)

    await h.svc.history(REPORT_ID, { id: REPORT_ID, limit: 500 }, OPERATOR_ID)
    await h.svc.history(REPORT_ID, { id: REPORT_ID, limit: 5 }, OPERATOR_ID)

    expect(h.historyCalls[0]?.limit).toBe(50)
    expect(h.historyCalls[1]?.limit).toBe(5)
  })

  it("returns pins on the initial page and omits them on a paged request", async () => {
    const pin = messageDTO({ id: MESSAGE_ID })
    const h = serviceHarness({ pins: [pin] })
    h.repo.seedReport(REPORT_ID)

    const first = await h.svc.history(REPORT_ID, { id: REPORT_ID }, OPERATOR_ID)
    const paged = await h.svc.history(REPORT_ID, { id: REPORT_ID, before: MESSAGE_ID }, OPERATOR_ID)

    expect(first.pins).toHaveLength(1)
    expect(paged.pins).toBeUndefined()
  })
})

describe("admin report chat send (attributed operator message, no membership required)", () => {
  it("persists into the REPORT room as the operator's own user id", async () => {
    const h = serviceHarness()
    h.repo.seedReport(REPORT_ID)

    const { message } = await h.svc.sendMessage(REPORT_ID, {
      body: "Crew dispatched.",
      actorId: OPERATOR_ID,
    })

    expect(h.send.persisted).toHaveLength(1)
    expect(h.send.persisted[0]).toMatchObject({
      cleanupId: REPORT_ID,
      roomKind: "report",
      userId: OPERATOR_ID,
      body: "Crew dispatched.",
    })
    expect(message.body).toBe("Crew dispatched.")
  })

  it("does NOT require a report_chat_members row: the send succeeds with an empty room", async () => {
    const h = serviceHarness()
    h.repo.seedReport(REPORT_ID)

    const { message } = await h.svc.sendMessage(REPORT_ID, { body: "Noted.", actorId: OPERATOR_ID })

    expect(message.id).toBe(MESSAGE_ID)
    expect(h.send.notified).toHaveLength(1)
    expect(h.send.notified[0]?.reportId).toBe(REPORT_ID)
  })

  it("does NOT create a report_chat_members row: the send path exposes no membership write", () => {
    const h = sendHarness()
    const seams = Object.keys(h.deps).sort()

    expect(seams).toEqual([
      "broadcast",
      "forwardCityMention",
      "mentions",
      "notifyMembers",
      "persist",
    ])
    expect(h.deps.persist.length).toBe(1)
  })

  it("broadcasts the message to the report's WS room key", async () => {
    const h = serviceHarness()
    h.repo.seedReport(REPORT_ID)

    await h.svc.sendMessage(REPORT_ID, { body: "Crew dispatched.", actorId: OPERATOR_ID })

    expect(h.send.broadcasts).toHaveLength(1)
    expect(h.send.broadcasts[0]?.roomKey).toBe(roomKeyFor("report", REPORT_ID))
  })

  it("neutralizes viewer-scoped fields in the broadcast copy", async () => {
    const send = sendHarness({
      persistBody: (input) => messageDTO({ body: input.body, mine: true }),
    })
    const h = serviceHarness({ send })
    h.repo.seedReport(REPORT_ID)

    await h.svc.sendMessage(REPORT_ID, { body: "Crew dispatched.", actorId: OPERATOR_ID })

    expect(h.send.broadcasts[0]?.message.mine).toBe(false)
  })

  it("runs the city-mention forward on the operator's message, attributed to the operator", async () => {
    const h = serviceHarness()
    h.repo.seedReport(REPORT_ID)

    await h.svc.sendMessage(REPORT_ID, { body: "@losangeles please fix", actorId: OPERATOR_ID })

    expect(h.send.forwarded).toHaveLength(1)
    expect(h.send.forwarded[0]?.reportId).toBe(REPORT_ID)
    expect(h.send.forwarded[0]?.actorUserId).toBe(OPERATOR_ID)
    expect(h.send.forwarded[0]?.message.body).toBe("@losangeles please fix")
  })

  it("routes EVERY operator message through the forward, which owns the @city decision", async () => {
    const h = serviceHarness()
    h.repo.seedReport(REPORT_ID)

    await h.svc.sendMessage(REPORT_ID, { body: "no mention here", actorId: OPERATOR_ID })

    expect(h.send.forwarded).toHaveLength(1)
    expect(h.send.forwarded[0]?.message.body).toBe("no mention here")
  })

  it("persists resolved user mentions and fires their bells", async () => {
    const mention: UserMentionDTO = { id: MEMBER_ID, handle: "dana", displayName: "Dana" }
    const send = sendHarness({ mentions: [mention] })
    const h = serviceHarness({ send })
    h.repo.seedReport(REPORT_ID)

    const { message } = await h.svc.sendMessage(REPORT_ID, {
      body: "@dana see this",
      actorId: OPERATOR_ID,
    })

    expect(h.send.recorded).toEqual([{ messageId: MESSAGE_ID, mentionedUserIds: [MEMBER_ID] }])
    expect(message.mentions).toEqual([mention])
    expect(h.send.bells).toEqual([{ mentionedUserId: MEMBER_ID, actorUserId: OPERATOR_ID }])
  })

  it("resolves mentions scoped to the report room, so scope rules stay as-is", async () => {
    const send = sendHarness({ mentions: [] })
    const h = serviceHarness({ send })
    h.repo.seedReport(REPORT_ID)

    await h.svc.sendMessage(REPORT_ID, { body: "@stranger hello", actorId: OPERATOR_ID })

    expect(h.send.membershipChecks).toEqual([REPORT_ID])
    expect(h.send.recorded).toHaveLength(0)
    expect(h.send.bells).toHaveLength(0)
  })

  it("404s when the report row does not exist, without persisting anything", async () => {
    const h = serviceHarness()

    await expect(
      h.svc.sendMessage(REPORT_ID, { body: "Crew dispatched.", actorId: OPERATOR_ID }),
    ).rejects.toBeInstanceOf(AppError)
    expect(h.send.persisted).toHaveLength(0)
    expect(h.send.broadcasts).toHaveLength(0)
    expect(h.send.forwarded).toHaveLength(0)
  })

  it("still returns the message when a best-effort side effect throws", async () => {
    const send = sendHarness()
    send.deps.notifyMembers = () => Promise.reject(new Error("bells down"))
    send.deps.forwardCityMention = () => Promise.reject(new Error("mail down"))
    const h = serviceHarness({ send })
    h.repo.seedReport(REPORT_ID)

    const { message } = await h.svc.sendMessage(REPORT_ID, {
      body: "Crew dispatched.",
      actorId: OPERATOR_ID,
    })

    expect(message.id).toBe(MESSAGE_ID)
  })

  it("survives a mention seam that throws, recording nothing", async () => {
    const send = sendHarness()
    send.deps.mentions = {
      resolveChatMentions: () => Promise.reject(new Error("resolver down")),
      recordChatMentions: () => Promise.resolve(),
    }
    const h = serviceHarness({ send })
    h.repo.seedReport(REPORT_ID)

    const { message } = await h.svc.sendMessage(REPORT_ID, {
      body: "@dana hello",
      actorId: OPERATOR_ID,
    })

    expect(message.mentions).toEqual([])
    expect(h.send.broadcasts).toHaveLength(1)
  })
})

describe("admin report chat remove (operator tombstone + audit)", () => {
  it("tombstones the message and writes an audit entry carrying the reason", async () => {
    const h = serviceHarness()
    h.repo.seedReport(REPORT_ID)
    h.repo.seedMessage({ id: MESSAGE_ID, reportId: REPORT_ID })

    await h.svc.removeMessage(REPORT_ID, MESSAGE_ID, {
      reason: "abusive",
      actorId: OPERATOR_ID,
    })

    expect(h.repo.messages.get(MESSAGE_ID)?.deletedAt).not.toBeNull()
    expect(h.repo.audits).toEqual([
      {
        actorId: OPERATOR_ID,
        action: "report_message.removed",
        target: `message:${MESSAGE_ID}`,
        meta: { reportId: REPORT_ID, reason: "abusive" },
      },
    ])
  })

  it("audits a null reason when the request omits one", async () => {
    const h = serviceHarness()
    h.repo.seedReport(REPORT_ID)
    h.repo.seedMessage({ id: MESSAGE_ID, reportId: REPORT_ID })

    await h.svc.removeMessage(REPORT_ID, MESSAGE_ID, { reason: null, actorId: OPERATOR_ID })

    expect(h.repo.audits[0]?.meta).toEqual({ reportId: REPORT_ID, reason: null })
  })

  it("404s for a message that belongs to a DIFFERENT report", async () => {
    const h = serviceHarness()
    h.repo.seedReport(REPORT_ID)
    h.repo.seedMessage({ id: MESSAGE_ID, reportId: "22222222-2222-2222-2222-222222222222" })

    await expect(
      h.svc.removeMessage(REPORT_ID, MESSAGE_ID, { reason: null, actorId: OPERATOR_ID }),
    ).rejects.toBeInstanceOf(AppError)
    expect(h.repo.audits).toHaveLength(0)
  })

  it("404s on a second remove and does not double-audit", async () => {
    const h = serviceHarness()
    h.repo.seedReport(REPORT_ID)
    h.repo.seedMessage({ id: MESSAGE_ID, reportId: REPORT_ID })

    await h.svc.removeMessage(REPORT_ID, MESSAGE_ID, { reason: null, actorId: OPERATOR_ID })
    await expect(
      h.svc.removeMessage(REPORT_ID, MESSAGE_ID, { reason: null, actorId: OPERATOR_ID }),
    ).rejects.toBeInstanceOf(AppError)

    expect(h.repo.audits).toHaveLength(1)
  })

  it("404s when the report row does not exist", async () => {
    const h = serviceHarness()
    h.repo.seedMessage({ id: MESSAGE_ID, reportId: REPORT_ID })

    await expect(
      h.svc.removeMessage(REPORT_ID, MESSAGE_ID, { reason: null, actorId: OPERATOR_ID }),
    ).rejects.toBeInstanceOf(AppError)
    expect(h.repo.messages.get(MESSAGE_ID)?.deletedAt).toBeNull()
  })
})

describe("sendReportChatMessage core (shared by the WS send path and the admin route)", () => {
  it("attaches mentions to the returned message only when some resolved", async () => {
    const withNone = sendHarness({ mentions: [] })
    const resolved = await sendReportChatMessage(withNone.deps, {
      reportId: REPORT_ID,
      senderId: OPERATOR_ID,
      body: "plain",
    })
    expect(resolved.mentions).toEqual([])
    expect(withNone.recorded).toHaveLength(0)
  })

  it("skips the mention round trip entirely when the body carries no handles", async () => {
    const h = sendHarness()
    await sendReportChatMessage(h.deps, {
      reportId: REPORT_ID,
      senderId: OPERATOR_ID,
      body: "no handles at all",
    })
    expect(h.membershipChecks).toHaveLength(0)
  })
})
