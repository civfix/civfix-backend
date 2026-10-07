/**
 * The single seam every report timeline writer routes through AFTER writing its `report_timeline` row, so
 * each event is mirrored into the report's group chat as a sender-less `kind:"system"` message.
 *
 * The timeline row is authoritative and the chat message only a reflection of it, so `emit` is best-effort:
 * a failure at insert, broadcast or notify is logged and never propagates, and a failed system message can
 * never fail or roll back the status change. Keep the call OUTSIDE the transaction that wrote the timeline
 * row, like the report's other post-commit side effects (onReportMessage / notifyReporter).
 *
 * Built from container primitives (makeContainerReportChatEmitter in report-chat-emitter.ts) so it can be
 * wired wherever the admin/citizen services are, without the chat-gateway wiring's instances.
 */

import type { ChatMessageDTO } from "@civfix/shared"

const EMIT_FAILED = "report-chat: system-message emit failed (suppressed)"

export interface ReportTimelineEvent {
  reportId: string
  /** The report status AT this event (a valid ReportStatus; validated by insertSystemMessage). */
  status: string
  /** Timeline kind (submit|route|status|done|remove|reply|...), or null/omitted. */
  kind?: string | null
  note?: string | null
  /** e.g. an inbound city reply body. */
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
  logger?: { warn: (obj: unknown, msg?: string) => void }
  propagateInsertFailure?: boolean
}

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
        warn({ err, reportId: event.reportId }, EMIT_FAILED)
        return
      }
      try {
        await deps.broadcast(deps.roomKeyFor("report", event.reportId), msg)
        await deps.notify(event.reportId, msg)
      } catch (err) {
        warn({ err, reportId: event.reportId }, EMIT_FAILED)
      }
    },
  }
}
