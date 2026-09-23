export const ATTACHMENT_FILENAME_MAX_CHARS = 120

// Only ever used through String#replace, which resets lastIndex, so sharing the /g regex is safe.
const UNSAFE_FILENAME_CHARS_RE = /[^A-Za-z0-9._-]+/g
const LEADING_DOTS_RE = /^\.+/

export function safeFilenameChars(name: string): string {
  return name.replace(UNSAFE_FILENAME_CHARS_RE, "_").replace(LEADING_DOTS_RE, "")
}
