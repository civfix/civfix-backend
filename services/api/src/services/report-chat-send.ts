import type { ChatMessageDTO, UserMentionDTO } from "@civfix/shared"
import type { PersistChatInput } from "@civfix/shared/interfaces"
import { resolveAndRecordChatMentions, type ChatMentionRecordSeam } from "./chat-mention-resolver.js"
import { neutralizeChatViewerFields } from "./chat-viewer-fields.js"
import { mapWithLimit } from "./media-presign.js"
import { roomKeyFor } from "../ws/gateway.js"
import type { GatewayChatMentions } from "../ws/types.js"

export const REPORT_MENTION_BELL_CONCURRENCY = 4

export type ReportChatMentionSeam = ChatMentionRecordSeam &
  Partial<Pick<GatewayChatMentions, "notifyChatMention">>

export interface ReportChatSendDeps {
  persist(input: PersistChatInput): Promise<ChatMessageDTO>
  broadcast(roomKey: string, message: ChatMessageDTO): Promise<void>
  mentions?: ReportChatMentionSeam | undefined
  notifyMembers?: ((reportId: string, message: ChatMessageDTO) => Promise<void>) | undefined
  forwardCityMention?:
    | ((reportId: string, message: ChatMessageDTO, actorUserId: string) => Promise<void>)
    | undefined
}

export interface ReportChatSendInput {
  reportId: string
  senderId: string
  body: string
  mentionedUserIds?: string[] | undefined
}

export async function sendReportChatMessage(
  deps: ReportChatSendDeps,
  input: ReportChatSendInput,
): Promise<ChatMessageDTO> {
  const persisted = await deps.persist({
    cleanupId: input.reportId,
    roomKind: "report",
    userId: input.senderId,
    body: input.body,
  })

  const mentions: UserMentionDTO[] = await resolveAndRecordChatMentions(deps.mentions, {
    body: input.body,
    mentionedUserIds: input.mentionedUserIds ?? [],
    authorUserId: input.senderId,
    kind: "report",
    roomId: input.reportId,
    messageId: persisted.id,
  })
  const message = mentions.length > 0 ? { ...persisted, mentions } : persisted

  const roomKey = roomKeyFor("report", input.reportId)
  void Promise.resolve(deps.broadcast(roomKey, neutralizeChatViewerFields(message))).catch(() => {})

  fireMentionBells(deps, input.reportId, input.senderId, mentions, message)
  if (deps.notifyMembers) void deps.notifyMembers(input.reportId, message).catch(() => {})
  if (deps.forwardCityMention) {
    void deps.forwardCityMention(input.reportId, message, input.senderId).catch(() => {})
  }

  return message
}

function fireMentionBells(
  deps: ReportChatSendDeps,
  reportId: string,
  actorUserId: string,
  mentions: UserMentionDTO[],
  message: ChatMessageDTO,
): void {
  const notify = deps.mentions?.notifyChatMention
  if (!notify || mentions.length === 0) return
  const seam = deps.mentions!
  void mapWithLimit(mentions, REPORT_MENTION_BELL_CONCURRENCY, (m) =>
    notify
      .call(seam, { kind: "report", roomId: reportId, actorUserId, mentionedUserId: m.id, message })
      .catch(() => {}),
  ).catch(() => {})
}
