import type { PushClearTarget, PushPayload } from "@civfix/seams"

// Hand-written to match the contract's encodePushMessageData and NOTIFICATION_SECTIONS until the
// backend adopts that contract (GH#221 replaces both).

export interface NotificationMessage {
  kind: "notification"
  payload: PushPayload
}

export interface ClearMessage {
  kind: "clear"
  target: PushClearTarget
}

export type PushMessage = NotificationMessage | ClearMessage

// Section ids are also the Android notification channel ids, so renaming one orphans that channel on
// every installed device.
const SECTION_BY_CATEGORY: Readonly<Record<string, string>> = {
  reportUpdates: "reports",
  reportDiscussions: "reports",
  directMessages: "messages",
  mentions: "messages",
  groupChats: "messages",
  events: "events",
  hostAnnouncements: "events",
  eventTeam: "events",
  followers: "social",
  likesAndReposts: "social",
  organizations: "organizations",
}

const DEFAULT_ANDROID_CHANNEL = "default"

export function androidChannelFor(category: string | null | undefined): string {
  if (category === undefined || category === null) return DEFAULT_ANDROID_CHANNEL
  return SECTION_BY_CATEGORY[category] ?? DEFAULT_ANDROID_CHANNEL
}

// FCM data carries only string values and APNs gets the same map, so absent fields are left out and
// arrays and booleans travel as strings.
export function encodeMessageData(message: PushMessage): Record<string, string> {
  if (message.kind === "clear") {
    return "all" in message.target
      ? { kind: "clear", all: "true" }
      : { kind: "clear", ids: JSON.stringify(message.target.ids) }
  }
  const { payload } = message
  const type = payload.data?.type
  return {
    kind: "notification",
    ...(payload.notificationId !== undefined ? { notificationId: payload.notificationId } : {}),
    ...(typeof type === "string" ? { type } : {}),
    ...(payload.category !== undefined && payload.category !== null
      ? { category: payload.category }
      : {}),
    ...(payload.link !== undefined ? { link: payload.link } : {}),
  }
}
