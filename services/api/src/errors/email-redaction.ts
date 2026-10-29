// Redacts exactly what /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g matches, in one linear pass. The
// regex retries from every character of a local-part run that no `@` follows, which is quadratic on an
// error message an attacker can fill with such a run.
const LOCAL_CHAR_RE = /^[A-Za-z0-9._%+-]$/
const DOMAIN_CHAR_RE = /^[A-Za-z0-9.-]$/
const LETTER_RE = /^[A-Za-z]$/
const MIN_TLD_LETTERS = 2

function runEnd(text: string, from: number, charRe: RegExp): number {
  let end = from
  while (charRe.test(text.charAt(end))) end++
  return end
}

// The regex's greedy domain part backtracks to the LAST dot that has a prefix of at least one character
// and two letters after it, then takes every letter that follows. Returns the match end, or -1.
function domainEnd(text: string, start: number): number {
  const end = runEnd(text, start, DOMAIN_CHAR_RE)
  for (let dot = end - 1 - MIN_TLD_LETTERS; dot > start; dot--) {
    if (
      text.charAt(dot) === "." &&
      LETTER_RE.test(text.charAt(dot + 1)) &&
      LETTER_RE.test(text.charAt(dot + 2))
    ) {
      return runEnd(text, dot + 1, LETTER_RE)
    }
  }
  return -1
}

export function redactEmails(text: string, replacement: string): string {
  let out = ""
  let copied = 0
  let index = 0
  while (index < text.length) {
    if (!LOCAL_CHAR_RE.test(text.charAt(index))) {
      index++
      continue
    }
    // `@` is not a local-part character, so every start inside this run reaches the same `@`, and the
    // leftmost start is the only one the regex would report.
    const at = runEnd(text, index, LOCAL_CHAR_RE)
    const end = text.charAt(at) === "@" ? domainEnd(text, at + 1) : -1
    if (end === -1) {
      index = at + 1
      continue
    }
    out += text.slice(copied, index) + replacement
    copied = end
    index = end
  }
  return out + text.slice(copied)
}
