import type { NotificationCategory } from "@civfix/contract"

export interface NotificationEmailCapability {
  userId: string
  category: NotificationCategory
  expiresAtMs: number
}

export function mintNotificationEmailToken(
  _capability: NotificationEmailCapability,
  _signingKey: string,
): string {
  throw new Error("not implemented")
}

export function verifyNotificationEmailToken(
  _token: string,
  _signingKey: string,
  _nowMs: number,
): NotificationEmailCapability | null {
  throw new Error("not implemented")
}

export function notificationEmailExpiryFrom(_sentAtMs: number): number {
  throw new Error("not implemented")
}
