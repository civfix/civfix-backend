import type { ChatMessageDTO } from "@civfix/shared"

const PREVIEW_MAX = 80

/** Display name first so a message notification names the person, matching the thread title. */
export function authorDisplay(message: ChatMessageDTO, fallback: string): string {
  const from = message.from
  // A sender-less SYSTEM message never raises a dm or mention bell, so a missing author just falls back
  // like a blank name would.
  if (!from) return fallback
  if (from.name.trim() !== "") return from.name
  if (from.handle) return `@${from.handle}`
  return fallback
}

/**
 * `null` for a non-text message so a structured payload never leaks as the preview; the caller then
 * substitutes localized copy. The preview is user content: it reaches the i18n renderer only as an
 * interpolation var, so the user's text is never translated.
 */
export function textPreview(message: ChatMessageDTO): string | null {
  const body = message.body
  if (message.kind === "text" && typeof body === "string" && body.trim() !== "") {
    const trimmed = body.trim()
    return trimmed.length > PREVIEW_MAX ? `${trimmed.slice(0, PREVIEW_MAX - 1)}…` : trimmed
  }
  return null
}

export const dmAuthorName = (message: ChatMessageDTO): string => authorDisplay(message, "")
export const mentionAuthorName = (message: ChatMessageDTO): string => authorDisplay(message, "")
