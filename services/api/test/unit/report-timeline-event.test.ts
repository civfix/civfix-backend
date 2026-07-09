import { describe, it, expect } from "vitest"
import type { ChatMessageDTO } from "@civfix/shared"
import {
  makeReportChatSystemEmitter,
  type ReportChatSystemEmitterDeps,
} from "../../src/services/report-timeline-event.js"

/**
 * Offline unit tests for the report-chat SYSTEM-message CHOKE POINT (Task D-D1). The emitter mirrors a
 * report timeline event into the report chat: insertSystemMessage -> broadcast -> notify, in that order.
 * It is FULLY best-effort: a throw at ANY step is swallowed so a failed system message never fails (nor
 * rolls back) the underlying status change.
 */

const REPORT = "11111111-1111-1111-1111-111111111111"

function systemMessage(): ChatMessageDTO {
  return {
    id: "sys-1",
    cleanupId: REPORT,
    roomKind: "report",
    from: null,
    body: "Status set to In progress",
    kind: "system",
    reactions: [],
    mentions: [],
    createdAt: new Date().toISOString(),
    system: { status: "in_progress" },
  }
}

interface Recorder {
  calls: string[]
  msg: ChatMessageDTO
  deps: ReportChatSystemEmitterDeps
}

function recorder(over?: Partial<ReportChatSystemEmitterDeps>): Recorder {
  const calls: string[] = []
  const msg = systemMessage()
  const deps: ReportChatSystemEmitterDeps = {
    reportChat: {
      insertSystemMessage: async (input) => {
        calls.push(`insert:${input.reportId}:${input.status}`)
        return msg
      },
    },
    broadcast: (roomKey, m) => {
      calls.push(`broadcast:${roomKey}:${m.id}`)
    },
    notify: async (reportId, m) => {
      calls.push(`notify:${reportId}:${m.id}`)
    },
    roomKeyFor: (kind, id) => `${kind}:${id}`,
    ...over,
  }
  return { calls, msg, deps }
}

describe("report-chat system-message emitter (D-D1 choke point)", () => {
  it("emit persists, then broadcasts to the room, then notifies members — in order", async () => {
    const { calls, deps } = recorder()
    const emitter = makeReportChatSystemEmitter(deps)

    await emitter.emit({ reportId: REPORT, status: "in_progress", kind: "status", note: "Status set to In progress" })

    expect(calls).toEqual([
      `insert:${REPORT}:in_progress`,
      `broadcast:report:${REPORT}:sys-1`,
      `notify:${REPORT}:sys-1`,
    ])
  })

  it("passes the exact event through to insertSystemMessage (status/kind/note/body)", async () => {
    let seen: unknown
    const { deps } = recorder({
      reportChat: {
        insertSystemMessage: async (input) => {
          seen = input
          return systemMessage()
        },
      },
    })
    const emitter = makeReportChatSystemEmitter(deps)
    const event = { reportId: REPORT, status: "resolved", kind: "done", note: "n", body: "b" }
    await emitter.emit(event)
    expect(seen).toEqual(event)
  })

  it("swallows an insertSystemMessage failure (emit resolves, never rejects)", async () => {
    const { deps } = recorder({
      reportChat: {
        insertSystemMessage: async () => {
          throw new Error("insert boom")
        },
      },
    })
    const emitter = makeReportChatSystemEmitter(deps)
    await expect(
      emitter.emit({ reportId: REPORT, status: "in_progress" }),
    ).resolves.toBeUndefined()
  })

  it("swallows a broadcast failure and does not reach notify", async () => {
    const { calls, deps } = recorder({
      broadcast: () => {
        throw new Error("broadcast boom")
      },
    })
    const emitter = makeReportChatSystemEmitter(deps)
    await expect(emitter.emit({ reportId: REPORT, status: "in_progress" })).resolves.toBeUndefined()
    expect(calls.some((c) => c.startsWith("notify:"))).toBe(false)
  })

  it("swallows a notify failure (emit resolves, never rejects)", async () => {
    const { deps } = recorder({
      notify: async () => {
        throw new Error("notify boom")
      },
    })
    const emitter = makeReportChatSystemEmitter(deps)
    await expect(
      emitter.emit({ reportId: REPORT, status: "in_progress" }),
    ).resolves.toBeUndefined()
  })
})
