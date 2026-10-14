import type { ChatMessageDTO } from "@civfix/shared"
import { makeRoomChatNotifier, type RoomChatNotifierDeps } from "./room-chat-notifier-adapter.js"

export { REPORT_CHAT_FANOUT_MEMBER_CAP } from "./chat-room-fanout-notifier.js"

export interface ReportChatNotifierDeps extends RoomChatNotifierDeps<"report"> {
  reportChatRepo: { listMemberIds(reportId: string, limit: number): Promise<string[]> }
}

export function makeReportChatNotifier(
  deps: ReportChatNotifierDeps,
): (reportId: string, message: ChatMessageDTO) => Promise<void> {
  return makeRoomChatNotifier("report", deps, (reportId, limit) =>
    deps.reportChatRepo.listMemberIds(reportId, limit),
  )
}
