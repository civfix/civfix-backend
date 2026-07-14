import type { NotificationType } from "@civfix/shared"
import type { NotificationService } from "./notification-service.js"

export type ConversationBellKind = "dm" | "cleanup" | "report"

export const CONVERSATION_BELL: Record<
  ConversationBellKind,
  { type: NotificationType; link: (id: string) => string }
> = {
  dm: { type: "dm", link: (id) => `/messages/dm/${id}` },
  cleanup: { type: "cleanup_chat", link: (id) => `/cleanups/${id}` },
  report: { type: "report_chat", link: (id) => `/messages/report/${id}` },
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
