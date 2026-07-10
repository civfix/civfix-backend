/**
 * Pure copy builders for the chat/dm bell notifications (no I/O). Shared by the gateway wiring so the dm
 * delivered-bell and the @-mention bell render consistent author/preview text.
 */

import type { ChatMessageDTO } from "@civfix/shared"

/** Max chars of a text dm preview surfaced in a bell body (server-side truncation). */
const PREVIEW_MAX = 80

/**
 * Author name for a message notification: the sender's DISPLAY NAME if present, else their @handle, else a
 * generic fallback (the dm bell uses "New message"; the mention bell uses "Someone"). Display-name-first so
 * a "message notification" names the person, not their @handle - matching the messaging header / thread title.
 */
export function authorDisplay(message: ChatMessageDTO, fallback: string): string {
  const from = message.from
  // DM/mention notifications are only ever built from an authored message (a sender-less SYSTEM message
  // has no dm/mention bell) - a missing author here just falls back like a blank name would.
  if (!from) return fallback
  if (from.name.trim() !== "") return from.name
  if (from.handle) return `@${from.handle}`
  return fallback
}

/**
 * The server-truncated preview of a text message (~80 chars, ellipsized), or `null` for a non-text
 * message (share_pin / task_complete / rsvp_change / a body-less frame) so a structured payload never
 * leaks as the preview. The caller substitutes a localized "Sent you a message" wrapper when this is null.
 *
 * The preview is USER CONTENT: it is passed to the i18n renderer as an interpolation var (already
 * truncated here), so only the surrounding notification copy is translated — never the user's text.
 */
export function textPreview(message: ChatMessageDTO): string | null {
  const body = message.body
  if (message.kind === "text" && typeof body === "string" && body.trim() !== "") {
    const trimmed = body.trim()
    return trimmed.length > PREVIEW_MAX ? `${trimmed.slice(0, PREVIEW_MAX - 1)}…` : trimmed
  }
  return null
}

/** The sender's display name for a DM bell title: @handle / display name / a generic fallback marker. */
export const dmAuthorName = (message: ChatMessageDTO): string => authorDisplay(message, "")
/** The mention author's display name: @handle / display name / a generic fallback marker. */
export const mentionAuthorName = (message: ChatMessageDTO): string => authorDisplay(message, "")
