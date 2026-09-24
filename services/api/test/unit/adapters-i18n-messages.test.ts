/**
 * Tests for the server message renderer (src/i18n) — previously untested, though every push body, bell
 * title and OTP email subject goes through it.
 *
 * What is pinned here:
 *   - resolution order: the target locale's catalog -> the English source -> the literal key (never empty,
 *     never a throw),
 *   - {{var}} interpolation, including an UNMATCHED placeholder being left intact rather than printing
 *     "undefined" to a user,
 *   - BCP-47 clamping (es-419 -> es, en_US -> en, junk -> en),
 *   - CATALOG INTEGRITY: every translated key exists in the English source (a typo'd key is silently dead
 *     copy, since the catalogs are Partial), and every translated string carries the SAME {{vars}} as its
 *     English source (a dropped placeholder means a name/status never appears in the notification).
 *
 * The naming here is deliberate: `Partial<Record<MessageKey, string>>` makes a MISSING key legal, so only
 * a test can tell an intentional gap from an accident. The English keys that no catalog translates are
 * listed explicitly below.
 */

import { describe, it, expect } from "vitest"
import { renderMessage } from "../../src/i18n/renderMessage.js"
import { resolveLocale, isSupportedLocale, SUPPORTED_LOCALES } from "../../src/i18n/locales.js"
import { en, type MessageKey } from "../../src/i18n/messages/en.js"
import { es } from "../../src/i18n/messages/es.js"
import { de } from "../../src/i18n/messages/de.js"
import { ko } from "../../src/i18n/messages/ko.js"

const CATALOGS: Record<string, Partial<Record<MessageKey, string>>> = { es, de, ko }

/** Keys intentionally left English in every catalog (see en.ts SCOPE note). */
const INTENTIONALLY_UNTRANSLATED: readonly MessageKey[] = []

function placeholders(template: string): string[] {
  return [...template.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1]!).sort()
}

describe("resolveLocale", () => {
  it("clamps a full BCP-47 tag to its base language", () => {
    expect(resolveLocale("es-419")).toBe("es")
    expect(resolveLocale("de-AT")).toBe("de")
    expect(resolveLocale("en_US")).toBe("en")
    expect(resolveLocale("KO-kr")).toBe("ko")
  })

  it("falls back to en for anything unsupported, absent or non-string", () => {
    expect(resolveLocale("fr")).toBe("en")
    expect(resolveLocale("")).toBe("en")
    expect(resolveLocale("   ")).toBe("en")
    expect(resolveLocale(undefined)).toBe("en")
    expect(resolveLocale(null)).toBe("en")
    expect(resolveLocale(42)).toBe("en")
  })

  it("isSupportedLocale is exact (no clamping)", () => {
    expect(isSupportedLocale("es")).toBe(true)
    expect(isSupportedLocale("es-419")).toBe(false)
    expect(isSupportedLocale(undefined)).toBe(false)
  })
})

describe("renderMessage", () => {
  it("renders the target locale's string when the catalog has the key", () => {
    expect(renderMessage("es", "notification.follower.title")).toBe("Nuevo seguidor")
    expect(renderMessage("de", "notification.follower.title")).toBe("Neuer Follower")
    expect(renderMessage("ko", "notification.follower.title")).toBe("새 팔로워")
  })

  it("names an event-team role in the reader's own language, never as the raw enum", () => {
    for (const locale of ["en", "es", "de", "ko"] as const) {
      for (const role of ["cohost", "coordinator", "staff"] as const) {
        const label = renderMessage(locale, `role.${role}` as MessageKey)
        expect(label).not.toBe(`role.${role}`)
        const body = renderMessage(locale, "notification.event_team_invite.body", {
          title: "Beach cleanup",
          role: label,
        })
        expect(body).toContain(label)
        if (locale !== "en") expect(body).not.toContain(role)
      }
    }
  })

  it("falls back to English for a key the catalog does not translate", () => {
    // Pick a key present in en and absent from es; if es ever translates it, this asserts nothing false.
    const missing = (Object.keys(en) as MessageKey[]).find((k) => es[k] === undefined)
    if (missing !== undefined) {
      expect(renderMessage("es", missing)).toBe(en[missing])
    }
  })

  it("falls back to the LITERAL key for a key no catalog defines", () => {
    const unknown = "notification.does.not.exist" as MessageKey
    expect(renderMessage("es", unknown)).toBe("notification.does.not.exist")
    expect(renderMessage("en", unknown)).toBe("notification.does.not.exist")
  })

  it("clamps the locale argument, so a raw users.locale is safe to pass", () => {
    expect(renderMessage("es-MX", "notification.follower.title")).toBe("Nuevo seguidor")
    expect(renderMessage("fr", "notification.follower.title")).toBe(
      en["notification.follower.title"],
    )
    expect(renderMessage(undefined, "notification.follower.title")).toBe(
      en["notification.follower.title"],
    )
  })

  it("interpolates {{vars}} and leaves an UNMATCHED placeholder intact", () => {
    expect(renderMessage("en", "notification.follower.body", { name: "@ada" })).toBe(
      "@ada started following you.",
    )
    // No vars at all: the template is returned untouched (never "undefined started following you").
    expect(renderMessage("en", "notification.follower.body")).toContain("{{name}}")
    expect(renderMessage("en", "notification.follower.body", { other: "x" })).toContain("{{name}}")
  })

  it("stringifies a numeric var", () => {
    expect(renderMessage("en", "notification.post.like.body", { name: 7 })).toBe(
      "7 liked your post.",
    )
  })
})

describe("catalog integrity", () => {
  it("every locale is renderable for every English key (no throw, never empty)", () => {
    for (const locale of SUPPORTED_LOCALES) {
      for (const key of Object.keys(en) as MessageKey[]) {
        expect(renderMessage(locale, key).length).toBeGreaterThan(0)
      }
    }
  })

  it("no catalog defines a key that is not in the English source", () => {
    const enKeys = new Set(Object.keys(en))
    for (const [locale, catalog] of Object.entries(CATALOGS)) {
      for (const key of Object.keys(catalog)) {
        expect(enKeys.has(key), `${locale}: unknown key ${key}`).toBe(true)
      }
    }
  })

  it("every translated string preserves the English {{vars}} exactly", () => {
    for (const [locale, catalog] of Object.entries(CATALOGS)) {
      for (const [key, translated] of Object.entries(catalog) as [MessageKey, string][]) {
        const source = en[key]
        expect(placeholders(translated), `${locale}: ${key}`).toEqual(placeholders(source))
      }
    }
  })

  /**
   * The service-hours transcript is a PDF handed to a school or a court, and every chrome string on it
   * comes from these catalogs. A missing overlay key falls back to English SILENTLY, so a ko transcript
   * would ship half in English and look forged. The generic gap check below would catch it too, but this
   * block names the feature so the failure message says which document broke.
   */
  it("every certificate.* key has a real es/de/ko translation (the PDF must not ship half-English)", () => {
    const certificateKeys = (Object.keys(en) as MessageKey[]).filter((k) =>
      k.startsWith("certificate."),
    )
    expect(certificateKeys.length).toBeGreaterThan(25)
    for (const [locale, catalog] of Object.entries(CATALOGS)) {
      for (const key of certificateKeys) {
        const translated = catalog[key]
        expect(typeof translated, `${locale}: missing ${key}`).toBe("string")
        expect((translated ?? "").trim().length, `${locale}: empty ${key}`).toBeGreaterThan(0)
      }
      // Presence alone cannot tell a translation from a copy-paste, and short labels legitimately
      // collide across languages ("Total" is "Total" in Spanish). The PROSE keys are where an
      // untranslated overlay is actually visible to the reader, so those must genuinely differ.
      for (const key of [
        "certificate.attestation.body",
        "certificate.table.truncated",
        "certificate.error.no_hours",
      ] as const satisfies readonly MessageKey[]) {
        expect(catalog[key], `${locale}: ${key} is a verbatim copy of the English source`).not.toBe(
          en[key],
        )
      }
    }
    expect(
      INTENTIONALLY_UNTRANSLATED.filter((k) => k.startsWith("certificate.")),
      "no certificate.* key may be declared intentionally untranslated",
    ).toEqual([])
  })

  it("the only untranslated English keys are the ones declared intentional", () => {
    const gaps = (Object.keys(en) as MessageKey[]).filter((key) =>
      Object.values(CATALOGS).some((catalog) => catalog[key] === undefined),
    )
    expect(gaps.sort()).toEqual([...INTENTIONALLY_UNTRANSLATED].sort())
  })
})
