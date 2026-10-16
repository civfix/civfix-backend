export type { PushPlatform } from "@civfix/contract"
import type { PushPlatform } from "@civfix/contract"

export interface PushPayload {
  title: string
  body?: string
  data?: Record<string, unknown>
  link?: string
  channelId?: string
}

export interface PushSender {
  registerToken(
    userId: string,
    token: string,
    platform: PushPlatform,
    deviceId?: string,
  ): Promise<void>
  send(userId: string, payload: PushPayload): Promise<void>
  sendMany(userIds: string[], payload: PushPayload): Promise<void>
}
