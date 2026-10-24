import type { NotificationCategory, NotificationType } from "@civfix/contract"

export function categoryForType(_type: NotificationType): NotificationCategory | null {
  throw new Error("not implemented")
}
