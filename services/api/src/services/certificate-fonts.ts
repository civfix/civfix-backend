/**
 * Font resolution for the service-hours transcript PDF.
 *
 * The faces live in `services/api/assets/fonts/` and reach the image because `.dockerignore` excludes no
 * `assets/` path and `services/api/package.json` declares no `files` field, so `pnpm --filter @civfix/api
 * --prod deploy` copies the whole package directory, exactly how `drizzle/*.sql` reaches the migrate
 * container. If a `files` field is ever added it MUST list `assets` (and keep listing `drizzle`).
 *
 * THE PATH TRAP. `tsup.config.ts` has `splitting: false`, so this module is bundled INTO
 * `dist/main.js` (depth 1 under the package root), while under tsx/vitest it runs from `src/services/`
 * at depth 2. An `import.meta.url`-relative path is therefore different in dev and prod, so the directory
 * is found by PROBING for `MANIFEST.json` and memoized.
 *
 * STATIC INSTANCES ONLY. pdfkit/fontkit embed a variable font's default instance only; a `wght`-axis VF
 * would render SemiBold as Regular with no error. See `assets/fonts/PROVENANCE.md`.
 */

import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
/** bundled: <api>/dist/main.js -> ".."; tsx/vitest: <api>/src/services -> "../.."; the third is slack. */
const CANDIDATES = ["..", "../..", "../../.."] as const

let cachedDir: string | undefined

export function fontsDir(): string {
  if (cachedDir) return cachedDir
  for (const up of CANDIDATES) {
    const candidate = join(HERE, up, "assets", "fonts")
    if (existsSync(join(candidate, "MANIFEST.json"))) {
      cachedDir = candidate
      return candidate
    }
  }
  throw new Error(`certificate fonts not found; probed ${CANDIDATES.join(", ")} from ${HERE}`)
}

export interface FontManifestEntry {
  file: string
  family: string
  weight: number
  license: string
  /** Lowercase hex SHA-256 of the file; re-hashed by certificate-fonts.test.ts on every run. */
  sha256: string
  source: string
}

export interface FontManifest {
  version: number
  fonts: FontManifestEntry[]
}

let cachedManifest: FontManifest | undefined

export function fontManifest(): FontManifest {
  if (cachedManifest) return cachedManifest
  const parsed = JSON.parse(readFileSync(join(fontsDir(), "MANIFEST.json"), "utf8")) as FontManifest
  cachedManifest = parsed
  return parsed
}

/**
 * Parsed-file cache. pdfkit accepts a Buffer in `registerFont`, so the ~5 MB Noto face is read from disk
 * at most once per process; pdfkit still re-parses it per PDFDocument, which is why the CJK face is
 * registered LAZILY (only when `fontFor` actually picks it) rather than up front.
 */
const buffers = new Map<string, Buffer>()

export function fontBuffer(file: string): Buffer {
  const hit = buffers.get(file)
  if (hit) return hit
  const bytes = readFileSync(join(fontsDir(), file))
  buffers.set(file, bytes)
  return bytes
}

/** Role -> vendored file. The only place a face's file name is written down. */
export const FONT = {
  /** The civfix wordmark only. */
  wordmark: "Baloo2-ExtraBold.ttf",
  /** Headings, eyebrows, stat numbers. */
  display: "BricolageGrotesque-SemiBold.ttf",
  /** Paragraphs, table cells. */
  body: "HankenGrotesk-Regular.ttf",
  /** Labels, table header, totals. */
  bodyBold: "HankenGrotesk-SemiBold.ttf",
  /** Certificate code, hours column, document fingerprint. */
  mono: "JetBrainsMono-Regular.ttf",
  /**
   * Korean/CJK fallback. Only the Regular weight is vendored: a CJK Bold is another ~4.8 MB in the
   * image for one typographic nuance, so `fontFor(text, "bold")` returns this same face for CJK text.
   */
  cjk: "NotoSansKR-Regular.otf",
} as const

export type FontRole = keyof typeof FONT

/**
 * Codepoint ranges the Latin brand faces cannot cover, i.e. roughly what Noto Sans KR provides.
 *
 * Written as numeric ranges rather than a regex with literal CJK characters on purpose: an ideographic
 * space inside a character class is invisible in review and trips `no-irregular-whitespace`, and a
 * `\uXXXX` escape is one bad copy/paste away from being silently replaced by the character it names.
 */
const CJK_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x11ff], // Hangul Jamo
  [0x3000, 0x303f], // CJK symbols and punctuation
  [0x3040, 0x30ff], // Hiragana + Katakana
  [0x3130, 0x318f], // Hangul Compatibility Jamo
  [0x3400, 0x4dbf], // CJK Unified Ideographs Extension A
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0xa960, 0xa97f], // Hangul Jamo Extended-A
  [0xac00, 0xd7ff], // Hangul Syllables + Hangul Jamo Extended-B
  [0xf900, 0xfaff], // CJK Compatibility Ideographs
  [0xff00, 0xffef], // Halfwidth and fullwidth forms
]

export function needsCjk(text: string): boolean {
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    for (const [lo, hi] of CJK_RANGES) {
      if (cp >= lo && cp <= hi) return true
    }
  }
  return false
}

/**
 * Pick the face for ONE string (a table cell, a heading), not per glyph run - a deliberate
 * simplification. A mixed "Cleanup at <hangul>" cell renders entirely in Noto Sans KR, which has full
 * Latin coverage, so it stays legible and is merely slightly off-brand.
 *
 * KNOWN LIMITATION: scripts outside the Noto Sans KR cmap (Arabic, Devanagari, Thai, ...) still render
 * `.notdef`. The follow-up is a NotoSans-Regular face plus a script-family map.
 */
export function fontFor(text: string, weight: "regular" | "bold"): string {
  if (needsCjk(text)) return FONT.cjk
  return weight === "bold" ? FONT.bodyBold : FONT.body
}
