/**
 * Pure copy builders for the chat/dm bell notifications (no I/O). Shared by the gateway wiring so the dm
 * delivered-bell and the @-mention bell render consistent author/preview text.
 */

import type { ChatMessageDTO } from "@civfix/shared"

/** Max chars of a text dm preview surfaced in a bell body (server-side truncation). */
const PREVIEW_MAX = 80

/**
 * Display name for a bell title: the sender's @handle if present, else their display name, else a generic
 * fallback (the dm bell uses "New message"; the mention bell uses "Someone").
 */
export function authorDisplay(message: ChatMessageDTO, fallback: string): string {
  const from = message.from
  if (from.handle) return `@${from.handle}`
  if (from.name.trim() !== "") return from.name
  return fallback
}

/**
 * Bell body: a server-truncated preview of a text message (~80 chars, ellipsized), or a generic
 * "Sent you a message" for a non-text message (share_pin / task_complete / rsvp_change / a body-less
 * frame), so a structured payload never leaks as the preview.
 */
export function messagePreview(message: ChatMessageDTO): string {
  const body = message.body
  if (message.kind === "text" && typeof body === "string" && body.trim() !== "") {
    const trimmed = body.trim()
    return trimmed.length > PREVIEW_MAX ? `${trimmed.slice(0, PREVIEW_MAX - 1)}…` : trimmed
  }
  return "Sent you a message"
}

export const dmNotificationTitle = (message: ChatMessageDTO): string => authorDisplay(message, "New message")
export const dmNotificationBody = messagePreview
export const mentionAuthorName = (message: ChatMessageDTO): string => authorDisplay(message, "Someone")
export const mentionBody = messagePreview
