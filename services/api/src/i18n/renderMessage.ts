import { type Locale, resolveLocale } from "./locales.js"
import { en, type MessageCatalog, type MessageKey } from "./messages/en.js"
import { es } from "./messages/es.js"
import { de } from "./messages/de.js"
import { ko } from "./messages/ko.js"

const CATALOGS: Record<Locale, MessageCatalog> = {
  en,
  es,
  de,
  ko,
}

export type MessageVars = Record<string, string | number>

const VAR_RE = /\{\{\s*([\w.]+)\s*\}\}/g

function interpolate(template: string, vars: MessageVars | undefined): string {
  if (!vars) return template
  return template.replace(VAR_RE, (match, name: string) => {
    const v = vars[name]
    return v === undefined ? match : String(v)
  })
}

/**
 * Falls back to the English string, then to the literal key, so a send never throws or emits an empty
 * string and an untranslated or mistyped key is visible.
 */
export function renderMessage(locale: unknown, key: MessageKey, vars?: MessageVars): string {
  const resolved: Locale = resolveLocale(locale)
  const template = CATALOGS[resolved][key] ?? en[key] ?? key
  return interpolate(template, vars)
}

export type { Locale, MessageKey }
