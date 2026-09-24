import { AppError } from "@civfix/shared"

const SLUR_BASES: readonly string[] = [
  "nigger",
  "nigga",
  "chink",
  "gook",
  "spic",
  "wetback",
  "kike",
  "coon",
  "beaner",
  "wop",
  "paki",
  "kyke",
  "faggot",
  "fag",
  "dyke",
  "tranny",
  "shemale",
  "retard",
  "retarded",
]

function buildPatterns(bases: readonly string[]): readonly RegExp[] {
  return bases.map((base) => {
    const expanded = base
      .split("")
      .map((ch) => `${ch}+`)
      .join("")
    return new RegExp(`\\b${expanded}(?:e?s)?\\b`, "i")
  })
}

const RAW_PATTERNS = buildPatterns(SLUR_BASES)

const DIGIT_LEET: Readonly<Record<string, string>> = {
  "0": "o",
  "1": "i",
  "3": "e",
  "4": "a",
  "5": "s",
}
const SYMBOL_LEET: Readonly<Record<string, string>> = { "!": "i", "|": "i", "@": "a" }

const LETTER_RE = /[a-z]/i

const SEPARATOR_BETWEEN_CHARS_RE = /([a-z0-9])[._\-*]+([a-z0-9])/gi

const SPACED_OUT_RUN_RE = /\b[a-z0-9](?: [a-z0-9])+\b/gi

const SPACE_RE = / /g

const SLUR_MESSAGE = "This contains language that isn't allowed."

function deLeet(s: string): string {
  let out = ""
  for (let i = 0; i < s.length; i++) {
    const ch = s.charAt(i)
    const symbol = SYMBOL_LEET[ch]
    if (symbol !== undefined) {
      out += symbol
      continue
    }
    const digit = DIGIT_LEET[ch]
    if (digit !== undefined) {
      const adjacentToLetter = LETTER_RE.test(s.charAt(i - 1)) || LETTER_RE.test(s.charAt(i + 1))
      out += adjacentToLetter ? digit : ch
      continue
    }
    out += ch
  }
  return out
}

function deobfuscate(text: string): string {
  const leet = deLeet(text)
  let collapsed = leet
  let prev: string
  do {
    prev = collapsed
    collapsed = collapsed.replace(SEPARATOR_BETWEEN_CHARS_RE, "$1$2")
  } while (collapsed !== prev)
  return collapsed.replace(SPACED_OUT_RUN_RE, (run) => run.replace(SPACE_RE, ""))
}

// Combining marks survive NFKD as separate code points and format characters (zero-width joiners, soft
// hyphen, bidi marks, BOM) render as nothing, so either one wedged inside a word hides it from the
// patterns. The unstripped variants stay because a zero-width space can also be the only word gap.
const COMBINING_MARK_RE = /\p{M}/gu
const FORMAT_CHAR_RE = /\p{Cf}/gu

export function containsSlur(text: string | null | undefined): boolean {
  if (text === null || text === undefined) return false
  const normalized = text.normalize("NFKD").toLowerCase()
  if (normalized.trim() === "") return false
  const stripped = normalized.replace(COMBINING_MARK_RE, "").replace(FORMAT_CHAR_RE, "")
  const variants = [normalized, deobfuscate(normalized), stripped, deobfuscate(stripped)]
  for (const variant of variants) {
    for (const pattern of RAW_PATTERNS) {
      if (pattern.test(variant)) return true
    }
  }
  return false
}

export function assertNoSlur(text: string | null | undefined, field = "body"): void {
  if (containsSlur(text)) {
    throw AppError.validation({ [field]: SLUR_MESSAGE })
  }
}
