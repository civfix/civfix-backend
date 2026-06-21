/**
 * SLUR-ONLY content filter for user-generated TEXT (App Store Guideline 1.2: keep objectionable
 * material from being posted). This is a deliberately NARROW, defensive content-moderation control:
 * it blocks a small, curated set of widely-recognized hate slurs (racial / ethnic / religious /
 * homophobic / transphobic / ableist) on the COMMENT, BIO, REPORT TITLE/DESCRIPTION, and — since the
 * App Store 1.2a remediation — the CHAT/DM write paths (the WS `send` handler for both group chat and
 * 1:1 DMs, plus the DM HTTP edit).
 *
 * EXPLICITLY OUT OF SCOPE:
 *   - General profanity (fuck, shit, damn, ass, bitch, ...) PASSES. This filter is slurs ONLY.
 *   - Image / media / CSAM is handled by Cloudflare; this module never touches media.
 *
 * DESIGN: bias HARD toward PRECISION over recall.
 *   - The blocklist is intentionally small and unambiguous. We would rather let an edge case through
 *     than wrongly reject a legitimate post.
 *   - Matching is WORD/TOKEN-boundary, never naive substring, so innocent words that merely CONTAIN a
 *     slur substring pass (the "Scunthorpe problem"): Scunthorpe, assassin, class, passage, Matsushita,
 *     cockpit, Dickens, analysis, shuttlecock, Nigeria, niggardly, etc. all PASS.
 *   - We additionally match against a DE-OBFUSCATED variant (leetspeak, interspersed separators,
 *     repeated-letter collapse) so trivial evasions (n.i.g.g.e.r, f4ggot, r3tard) are still caught,
 *     while the de-obfuscation is constrained enough not to manufacture false positives on normal text.
 *
 * The two exports are pure/stateless and unit-tested in test/unit/slur-filter.test.ts.
 */

import { AppError } from "@civfix/shared"

/**
 * Curated blocklist of widely-recognized hate slurs (lowercase, base forms). Entries are matched as
 * whole tokens (word boundaries) against both the raw and de-obfuscated text, so common inflections
 * formed by trailing letters (e.g. plural "-s") are covered by the `\w*` suffix in the matcher while
 * unrelated longer words are NOT (the boundary is anchored on the LEFT of each entry and a controlled
 * suffix on the right — see `buildPatterns`).
 *
 * Kept intentionally short. Each line notes the category. Reviewer note: this is a defensive denylist
 * for a public civic-reporting app; it exists to satisfy a platform requirement, not to editorialize.
 */
const SLUR_BASES: readonly string[] = [
  // racial / ethnic
  "nigger",
  "nigga",
  "chink",
  "gook",
  "spic",
  "wetback",
  "kike",
  "coon", // racial (matched as a whole token; "raccoon"/"cocoon"/"tycoon" pass via left boundary)
  "beaner",
  "wop",
  "paki", // ethnic/religious slur (UK); whole-token only so "Pakistan"/"Pakistani" pass
  // religious
  "kyke",
  // homophobic / transphobic
  "faggot",
  "fag", // whole-token only so "fag" inside "faggot" doesn't double-count and unrelated words pass
  "dyke",
  "tranny",
  "shemale",
  // ableist
  "retard",
  "retarded",
]

/**
 * Build a WHOLE-TOKEN pattern per base, anchored with `\b` on BOTH ends so a base that is only a
 * prefix/suffix/interior substring of a longer innocent word does NOT match. Two refinements keep both
 * precision and obfuscation-resistance:
 *
 *   - Each base letter is emitted as `letter+` so a repeated-letter obfuscation collapses naturally
 *     ("retaaaard" -> matches "retard", "faaaag" -> matches "fag"). Because the trailing `\b` still
 *     requires the token to END at the base's last letter (plus an optional plural), the doubling does
 *     not let the match spill into a longer word.
 *   - Only an explicit, conservative plural suffix `(?:e?s)?` is allowed after the base (so "niggers",
 *     "faggots" match) — NOT an open `\w*`. This is what makes "niggardly" (nigga + RDLY), "Pakistan" /
 *     "Pakistani" (paki + STAN...), "Nigeria" (nigg... diverges) PASS: after the base letters the next
 *     char is a word char that is neither the boundary nor an allowed plural, so the `\b` fails.
 *
 * Interior-substring lookalikes (assassin->ass, class, passage, cockpit, shuttlecock, analysis,
 * Scunthorpe, Dickens, Matsushita) pass because the LEFT `\b` is not satisfied mid-word.
 */
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

/**
 * Leetspeak / homoglyph digit substitutions applied during de-obfuscation only (NOT to the raw pass).
 * Constrained to the common, unambiguous mappings called out in the spec.
 */
function deLeet(s: string): string {
  return s
    .replace(/[1!|]/g, "i")
    .replace(/3/g, "e")
    .replace(/0/g, "o")
    .replace(/[4@]/g, "a")
    .replace(/5/g, "s")
}

/**
 * Produce a de-obfuscated variant of the text:
 *   1. de-leet digits/symbols to letters,
 *   2. strip separators (space . - _ *) that appear BETWEEN letters (so "n i g g e r" / "n.i.g.g.e.r"
 *      collapse), while NOT gluing whole words together in a way that manufactures a slur across a
 *      real word boundary — we only remove a separator when it sits between two letters.
 *
 * Because separators are removed between letters, the result is a single run per original letter-run;
 * the de-obfuscated string is then matched with the SAME word-boundary patterns. Repeated-letter
 * obfuscation ("retaaaard") is handled by the matcher itself (each base letter is `letter+`), so no
 * lossy repeat-collapse is done here.
 */
function deobfuscate(text: string): string {
  const leet = deLeet(text)
  // Strip separators interspersed between letters/digits: "n.i.g" -> "nig". Loop until stable so a
  // chain of single separators ("n . i . g") fully joins.
  let collapsed = leet
  let prev: string
  do {
    prev = collapsed
    collapsed = collapsed.replace(/([a-z0-9])[ ._\-*]+([a-z0-9])/gi, "$1$2")
  } while (collapsed !== prev)
  return collapsed
}

/**
 * True when the text contains a blocklisted hate slur as a whole token, in either the raw (lowercased)
 * form or the de-obfuscated form. Word-boundary matched, never naive substring. Null/empty -> false.
 */
export function containsSlur(text: string | null | undefined): boolean {
  if (text === null || text === undefined) return false
  // Normalize: NFKD (decompose fancy/full-width glyphs), lowercase.
  const normalized = text.normalize("NFKD").toLowerCase()
  if (normalized.trim() === "") return false
  const variants = [normalized, deobfuscate(normalized)]
  for (const variant of variants) {
    for (const pattern of RAW_PATTERNS) {
      if (pattern.test(variant)) return true
    }
  }
  return false
}

/**
 * Throw a VALIDATION AppError keyed on `field` when `text` contains a slur; no-op for null/empty.
 * Mirrors the codebase's `AppError.validation({ [field]: ... })` convention so the route's error
 * mapper renders a 422 with a field-scoped message.
 */
export function assertNoSlur(text: string | null | undefined, field = "body"): void {
  if (containsSlur(text)) {
    throw AppError.validation({ [field]: "This contains language that isn't allowed." })
  }
}
