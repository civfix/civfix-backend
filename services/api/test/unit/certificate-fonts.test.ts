/**
 * The vendored-font guard (DP §8.6): the same promise `scripts/copy-contract-fonts.mjs` gives the web
 * app, ported to the backend's `assets/fonts/`.
 *
 * A font that silently changes changes the printed document, and a font that silently DISAPPEARS takes
 * the certificate endpoint down in production only — the resolver probes at render time, not at boot. So
 * the manifest is re-hashed here, on every run, with no Docker and no network.
 */

import { createHash } from "node:crypto"
import { existsSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { FONT, fontBuffer, fontManifest, fontsDir } from "../../src/services/certificate-fonts.js"

/** A committed Git-LFS pointer is ~130 bytes of text; a real face is 60 KB - 5 MB. */
const MAX_FONT_BYTES = 8 * 1024 * 1024

describe("certificate fonts", () => {
  it("resolves the vendored directory under vitest", () => {
    const dir = fontsDir()
    expect(existsSync(join(dir, "MANIFEST.json"))).toBe(true)
    // Memoized: the second call must not re-probe to a different answer.
    expect(fontsDir()).toBe(dir)
  })

  it("re-hashes every manifest entry against the file on disk", () => {
    const manifest = fontManifest()
    expect(manifest.version).toBe(1)
    expect(manifest.fonts.length).toBeGreaterThanOrEqual(6)

    for (const entry of manifest.fonts) {
      const path = join(fontsDir(), entry.file)
      expect(existsSync(path), `${entry.file} is missing`).toBe(true)
      const actual = createHash("sha256").update(readFileSync(path)).digest("hex")
      expect(actual, `${entry.file} does not match MANIFEST.json`).toBe(entry.sha256)
      expect(entry.license).toBe("OFL-1.1")
    }
  })

  it("holds no empty file and nothing large enough to be a mistake", () => {
    for (const entry of fontManifest().fonts) {
      const bytes = statSync(join(fontsDir(), entry.file)).size
      expect(bytes, `${entry.file} is empty`).toBeGreaterThan(1024)
      expect(bytes, `${entry.file} is suspiciously large`).toBeLessThan(MAX_FONT_BYTES)
    }
  })

  it("ships the OFL license text beside the fonts", () => {
    const ofl = readFileSync(join(fontsDir(), "OFL.txt"), "utf8")
    expect(ofl).toContain("SIL OPEN FONT LICENSE Version 1.1")
    // Every vendored family's copyright notice must be reproduced, which is what the license requires.
    for (const family of ["Baloo 2", "Bricolage Grotesque", "Hanken Grotesk", "JetBrains Mono"]) {
      expect(ofl).toContain(family)
    }
    expect(ofl).toContain("Adobe")
  })

  it("maps every FONT role to a manifested file", () => {
    const files = new Set(fontManifest().fonts.map((f) => f.file))
    for (const [role, file] of Object.entries(FONT)) {
      expect(files.has(file), `FONT.${role} -> ${file} is not in MANIFEST.json`).toBe(true)
    }
  })

  it("reads and memoizes font buffers", () => {
    const first = fontBuffer(FONT.body)
    expect(first.length).toBeGreaterThan(1024)
    expect(fontBuffer(FONT.body)).toBe(first)
  })
})
