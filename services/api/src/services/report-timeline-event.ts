/**
 * Task D-D1: the CHOKE POINT that mirrors every report TIMELINE event into that report's group chat.
 *
 * Today a report status/timeline change writes a `report_timeline` row (the source of truth) but never
 * touches the chat. This module is the single seam every timeline writer routes through AFTER it has
 * written its row: it posts a sender-less `kind:"system"` chat message into the report room, broadcasts it
 * to the room's live sockets, and pushes the (non-present/non-muted) members.
 *
 * The timeline row is authoritative; the system chat message is a REFLECTION of it. So `emit` is FULLY
 * best-effort: any failure at any of the three steps (insert / broadcast / notify) is caught + logged and
 * NEVER propagates. Callers may still `await emit(...)` — it just never rejects, so a failed system
 * message can never fail or roll back the underlying status change. Keep the call OUTSIDE the DB
 * transaction that wrote the timeline row (a post-commit side effect, like the report's other
 * best-effort side effects — onReportMessage / notifyReporter).
 *
 * Constructed from CONTAINER PRIMITIVES (see makeContainerReportChatEmitter in report-chat-emitter.ts) so
 * it can be built wherever the admin/citizen services are wired, without depending on the chat-gateway
 * wiring's instances. Injectable as a fake in tests (mirrors the existing service override seams).
 */

import type { ChatMessageDTO } from "@civfix/shared"

/** A single report timeline event to reflect into the report chat. */
export interface ReportTimelineEvent {
  reportId: string
  /** The report status AT this event (a valid ReportStatus; validated by insertSystemMessage). */
  status: string
  /** Timeline kind (submit|route|status|done|remove|reply|...), or null/omitted. */
  kind?: string | null
  /** Short preview note. */
  note?: string | null
  /** Full text (e.g. an inbound city reply body). */
  body?: string | null
}

export interface ReportChatSystemEmitter {
  emit(event: ReportTimelineEvent): Promise<void>
}

export interface ReportChatSystemEmitterDeps {
  reportChat: {
    insertSystemMessage(input: {
      reportId: string
      status: string
      kind?: string | null
      note?: string | null
      body?: string | null
    }): Promise<ChatMessageDTO>
  }
  broadcast: (roomKey: string, message: ChatMessageDTO) => void | Promise<void>
  notify: (reportId: string, message: ChatMessageDTO) => Promise<void>
  roomKeyFor: (kind: "report", id: string) => string
  /** Optional logger for the swallowed best-effort failures (defaults to a no-op). */
  logger?: { warn: (obj: unknown, msg?: string) => void }
  propagateInsertFailure?: boolean
}

/**
 * Build the report-chat SYSTEM-message emitter. `emit(event)`:
 *   1. persists the system chat row      (reportChat.insertSystemMessage)
 *   2. broadcasts it to the live room     (broadcast(roomKeyFor("report", id), msg))
 *   3. pushes the members                 (notify(id, msg))
 */
export function makeReportChatSystemEmitter(
  deps: ReportChatSystemEmitterDeps,
): ReportChatSystemEmitter {
  const warn = (obj: unknown, msg: string): void => deps.logger?.warn(obj, msg)
  return {
    async emit(event: ReportTimelineEvent): Promise<void> {
      let msg: ChatMessageDTO
      try {
        msg = await deps.reportChat.insertSystemMessage(event)
      } catch (err) {
        if (deps.propagateInsertFailure === true) throw err
        warn(
          { err, reportId: event.reportId },
          "report-chat: system-message emit failed (suppressed)",
        )
        return
      }
      try {
        await deps.broadcast(deps.roomKeyFor("report", event.reportId), msg)
        await deps.notify(event.reportId, msg)
      } catch (err) {
        warn(
          { err, reportId: event.reportId },
          "report-chat: system-message emit failed (suppressed)",
        )
      }
    },
  }
}
