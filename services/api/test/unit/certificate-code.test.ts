/**
 * The printed capability. The code is what a registrar types off paper, so the tests care
 * about two things: the shape survives the round trip through the shared normalizer, and the draw is a
 * real CSPRNG draw over the whole alphabet.
 */

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  CERTIFICATE_CODE_ALPHABET,
  CERTIFICATE_CODE_LENGTH,
  CERTIFICATE_CODE_RE,
} from "@civfix/shared"
import { describe, expect, it } from "vitest"
import {
  CERTIFICATE_CODE_MINT_ATTEMPTS,
  formatCertificateCode,
  generateCertificateCode,
  normalizeCertificateCode,
} from "../../src/services/certificate-code.js"

const HERE = dirname(fileURLToPath(import.meta.url))
const SOURCE = join(HERE, "..", "..", "src", "services", "certificate-code.ts")

describe("generateCertificateCode", () => {
  it("mints canonical 12-char Crockford codes", () => {
    for (let i = 0; i < 50; i++) {
      const code = generateCertificateCode()
      expect(code).toHaveLength(CERTIFICATE_CODE_LENGTH)
      expect(code).toMatch(CERTIFICATE_CODE_RE)
      for (const ch of code) expect(CERTIFICATE_CODE_ALPHABET).toContain(ch)
    }
  })

  it("never emits the ambiguous letters the alphabet drops", () => {
    const drawn = Array.from({ length: 200 }, () => generateCertificateCode()).join("")
    expect(drawn).not.toMatch(/[ILOU]/)
  })

  it("draws across the whole alphabet (a stuck or biased RNG fails this)", () => {
    const seen = new Set<string>()
    for (let i = 0; i < 500; i++) for (const ch of generateCertificateCode()) seen.add(ch)
    expect(seen.size).toBe(CERTIFICATE_CODE_ALPHABET.length)
  })

  it("does not repeat itself", () => {
    const codes = new Set(Array.from({ length: 500 }, () => generateCertificateCode()))
    expect(codes.size).toBe(500)
  })

  it("round-trips through the shared display form", () => {
    const code = generateCertificateCode()
    const display = formatCertificateCode(code)
    expect(display).toMatch(
      /^CFX-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/,
    )
    expect(normalizeCertificateCode(display)).toBe(code)
    expect(normalizeCertificateCode(display.toLowerCase())).toBe(code)
  })

  it("bounds the mint retry", () => {
    expect(CERTIFICATE_CODE_MINT_ATTEMPTS).toBe(5)
  })

  /**
   * A tripwire, not a proof: `Math.random` is not a CSPRNG and `randomBytes(n) % 32` is modulo-biased,
   * and either would still pass every behavioural assertion above.
   */
  it("draws through the audited rejection-sampling primitive", () => {
    // Comments are stripped first: the module's own doc block NAMES both banned constructions in order
    // to forbid them, and a grep over the raw text would flag that as the violation.
    const code = readFileSync(SOURCE, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1")
    expect(code).toContain("randomIntBelow")
    expect(code).not.toMatch(/Math\s*\.\s*random/)
    expect(code).not.toMatch(/randomBytes/)
  })
})
