/**
 * Standalone (NO React, NO i18next runtime) message renderer for server-generated user-facing copy.
 *
 * A simple typed lookup with `{{var}}` interpolation + English fallback, keyed identically to the client
 * catalogs (per the i18n design spec). Resolution per key: the target locale's catalog -> the English
 * source -> the literal key (so a never-translated/typo'd key is visible rather than silently empty).
 *
 * Usage:
 *   renderMessage(user.locale, "notification.follower.body", { name })
 *   renderMessage("en", "email.otp.subject")
 */

import { type Locale, resolveLocale } from "./locales.js"
import { en, type MessageCatalog, type MessageKey } from "./messages/en.js"
import { es } from "./messages/es.js"
import { de } from "./messages/de.js"
import { ko } from "./messages/ko.js"

/** All four catalogs, keyed by locale. `en` is the complete source; es/de/ko are (partial) overlays. */
const CATALOGS: Record<Locale, MessageCatalog> = {
  en,
  es,
  de,
  ko,
}

export type MessageVars = Record<string, string | number>

const VAR_RE = /\{\{\s*([\w.]+)\s*\}\}/g

/** Substitute every `{{var}}` with the matching `vars` value; an unmatched placeholder is left intact. */
function interpolate(template: string, vars: MessageVars | undefined): string {
  if (!vars) return template
  return template.replace(VAR_RE, (match, name: string) => {
    const v = vars[name]
    return v === undefined ? match : String(v)
  })
}

/**
 * Render `key` in `locale` with `vars`. `locale` is clamped to a supported code (so a raw `users.locale`
 * or `Accept-Language` base tag is safe to pass directly). Falls back to the English string, then to the
 * literal key, so a send never throws or emits an empty string.
 */
export function renderMessage(locale: unknown, key: MessageKey, vars?: MessageVars): string {
  const resolved: Locale = resolveLocale(locale)
  const template = CATALOGS[resolved][key] ?? en[key] ?? key
  return interpolate(template, vars)
}

export type { Locale, MessageKey }
