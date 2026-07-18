import type { NotificationType } from "@civfix/shared"
import type { NotificationService } from "./notification-service.js"

export type ConversationBellKind = "dm" | "cleanup" | "report" | "group"

export const CONVERSATION_BELL: Record<
  ConversationBellKind,
  { type: NotificationType; link: (id: string) => string }
> = {
  dm: { type: "dm", link: (id) => `/messages/dm/${id}` },
  cleanup: { type: "cleanup_chat", link: (id) => `/cleanups/${id}` },
  report: { type: "report_chat", link: (id) => `/messages/report/${id}` },
  // P4 group lane (chat-p0): opening a group room clears its group_chat bells, same clear-on-open pattern.
  group: { type: "group_chat", link: (id) => `/messages/group/${id}` },
}

export function clearConversationBellFor(
  notificationService: Pick<NotificationService, "clearByTypeAndLink">,
  kind: ConversationBellKind,
  id: string,
  userId: string,
): Promise<void> {
  const spec = CONVERSATION_BELL[kind]
  return notificationService.clearByTypeAndLink(userId, spec.type, spec.link(id))
}
