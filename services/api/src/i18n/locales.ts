/**
 * Supported server locales (i18n). `en` is the source catalog + the fallback for every key and for
 * any unsupported/absent locale. Kept in lockstep with the client `LocaleEnum` (@civfix/shared) and
 * the four client catalogs. The DB column `users.locale` is the source of truth for server-generated
 * user-facing copy; this module owns clamping an arbitrary stored/incoming value to a supported code.
 */

export const SUPPORTED_LOCALES = ["en", "es", "de", "ko"] as const

export type Locale = (typeof SUPPORTED_LOCALES)[number]

export const DEFAULT_LOCALE: Locale = "en"

/**
 * Clamp an arbitrary value (a stored `users.locale`, a request field, or an `Accept-Language` base
 * tag) to a supported locale. A full BCP-47 tag is reduced to its base language (`es-419` -> `es`);
 * anything not in {en,es,de,ko} falls back to `en`. Pure + total (never throws).
 */
export function resolveLocale(value: unknown): Locale {
  if (typeof value !== "string" || value.trim() === "") return DEFAULT_LOCALE
  const base = value.trim().toLowerCase().split(/[-_]/)[0]
  return (SUPPORTED_LOCALES as readonly string[]).includes(base ?? "")
    ? (base as Locale)
    : DEFAULT_LOCALE
}

/** Type guard: is the value one of the four supported locale codes (exact, no clamping)? */
export function isSupportedLocale(value: unknown): value is Locale {
  return typeof value === "string" && (SUPPORTED_LOCALES as readonly string[]).includes(value)
}
