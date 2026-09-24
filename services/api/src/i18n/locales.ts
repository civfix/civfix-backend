/** Kept in lockstep with the client `LocaleEnum` in @civfix/shared and the four client catalogs. */

export const SUPPORTED_LOCALES = ["en", "es", "de", "ko"] as const

export type Locale = (typeof SUPPORTED_LOCALES)[number]

export const DEFAULT_LOCALE: Locale = "en"

/** Total: a BCP-47 tag reduces to its base language (`es-419` -> `es`); anything else becomes `en`. */
export function resolveLocale(value: unknown): Locale {
  if (typeof value !== "string" || value.trim() === "") return DEFAULT_LOCALE
  const base = value.trim().toLowerCase().split(/[-_]/)[0]
  return (SUPPORTED_LOCALES as readonly string[]).includes(base ?? "")
    ? (base as Locale)
    : DEFAULT_LOCALE
}

export function isSupportedLocale(value: unknown): value is Locale {
  return typeof value === "string" && (SUPPORTED_LOCALES as readonly string[]).includes(value)
}
