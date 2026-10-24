import type { Mailer } from "@civfix/seams"
import type { Env } from "../env.js"
import type { NotificationEmailThrottle } from "../adapters/notification-email-throttle.js"

export interface NotificationEmailConfig {
  from: string
  webBaseUrl: string
  apiBaseUrl: string
  signingKey: string
}

export interface NotificationEmailDeps {
  mailer: Mailer
  throttle: NotificationEmailThrottle
  config: NotificationEmailConfig
}

export function notificationEmailConfigOf(_env: Env): NotificationEmailConfig {
  throw new Error("not implemented")
}
