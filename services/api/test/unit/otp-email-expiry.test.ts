import { describe, expect, it } from "vitest"
import { renderOtp } from "../../src/adapters/mailer.oci.js"
import { OTP_TTL_SECONDS } from "../../src/auth/otp.js"
import { SUPPORTED_LOCALES } from "../../src/i18n/locales.js"
import { en } from "../../src/i18n/messages/en.js"
import { es } from "../../src/i18n/messages/es.js"
import { de } from "../../src/i18n/messages/de.js"
import { ko } from "../../src/i18n/messages/ko.js"

const CATALOGS: Record<string, Partial<Record<string, string>>> = { en, es, de, ko }

const TTL_MINUTES = String(Math.floor(OTP_TTL_SECONDS / 60))

describe("sign-in code email expiry line", () => {
  it.each(SUPPORTED_LOCALES)("states the real code lifetime in %s", (locale) => {
    const { text, html } = renderOtp("424242", locale)

    expect(text).toContain(TTL_MINUTES)
    expect(text).not.toContain("{{")
    expect(html).not.toContain("{{")
  })

  it.each(SUPPORTED_LOCALES)("derives the lifetime from the OTP TTL in %s", (locale) => {
    expect(CATALOGS[locale]!["email.otp.body_expiry"]).toContain("{{minutes}}")
  })
})
