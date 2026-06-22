/**
 * Honeypot check (PURE): a form field hidden from real users that a naive bot will fill, so any
 * non-empty value is a bot signal. Trims first so a stray-whitespace round-trip (some autofill stacks)
 * is NOT punished. Used by the anon-submit path; the authed report-service applies the same rule inline.
 * Tolerates null/undefined (returns false), unlike a bare `.trim()`.
 */
export function honeypotTripped(honeypot: string | undefined | null): boolean {
  if (honeypot === undefined || honeypot === null) return false
  return honeypot.trim() !== ""
}
