import { NOTIFICATION_SECTIONS } from "@civfix/contract"
import type { NotificationCategory, PushMessageData } from "@civfix/contract"
import type { PushClearTarget, PushPayload } from "@civfix/seams"

export interface NotificationMessage {
  kind: "notification"
  payload: PushPayload
}

export interface ClearMessage {
  kind: "clear"
  target: PushClearTarget
}

export type PushMessage = NotificationMessage | ClearMessage

/** What the app decodes from every push, before the contract's encodePushMessageData flattens it. */
export function pushMessageData(message: PushMessage): PushMessageData {
  if (message.kind === "clear") return { kind: "clear", ...message.target }
  const { payload } = message
  return {
    kind: "notification",
    notificationId: payload.notificationId,
    type: payload.type,
    category: payload.category,
    link: payload.link ?? null,
  }
}

// Section ids are also the Android notification channel ids, so renaming one orphans that channel on
// every installed device.
const SECTION_BY_CATEGORY: ReadonlyMap<NotificationCategory, string> = new Map(
  NOTIFICATION_SECTIONS.flatMap((section) =>
    section.categories.map((category) => [category, section.id] as const),
  ),
)

const DEFAULT_ANDROID_CHANNEL = "default"

export function androidChannelFor(category: NotificationCategory | null): string {
  if (category === null) return DEFAULT_ANDROID_CHANNEL
  return SECTION_BY_CATEGORY.get(category) ?? DEFAULT_ANDROID_CHANNEL
}
