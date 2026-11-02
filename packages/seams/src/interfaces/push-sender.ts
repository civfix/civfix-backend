export type { PushPlatform } from "@civfix/contract"
import type { NotificationCategory, NotificationType, PushPlatform } from "@civfix/contract"

export interface PushPayload {
  title: string
  body?: string
  link?: string
  channelId?: string
  /** The recipient's own notification row: devices use it to tag, collapse and later clear the push. */
  notificationId: string
  type: NotificationType
  /** `null` for an Always on notification. */
  category: NotificationCategory | null
}

export interface PushItem {
  userId: string
  payload: PushPayload
}

export type PushClearTarget = { ids: string[] } | { all: true }

export interface PushSender {
  registerToken(
    userId: string,
    token: string,
    platform: PushPlatform,
    deviceId?: string,
  ): Promise<void>
  send(userId: string, payload: PushPayload): Promise<void>
  sendEach(items: PushItem[]): Promise<void>
  /** Removes delivered pushes from the user's phones; clears made close together go out as one. */
  clear(userId: string, target: PushClearTarget): Promise<void>
}
