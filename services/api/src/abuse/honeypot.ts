/**
 * Honeypot check (PURE).
 *
 * A honeypot is a form field hidden from real users (off-screen / display:none) that a naive bot will
 * happily fill. Any non-empty value is therefore a strong bot signal. This module is the single source
 * of that decision so the anon-submit and authed-create paths agree on the rule.
 *
 * The check trims first: a real client that round-trips a stray whitespace value (some autofill stacks
 * inject one) is NOT punished; only genuine content trips it. This mirrors the authed report-service's
 * honeypot handling so the two paths behave identically.
 */

/** True when the honeypot field carries real (non-whitespace) content, i.e. a likely bot. */
export function honeypotTripped(honeypot: string | undefined | null): boolean {
  if (honeypot === undefined || honeypot === null) return false
  return honeypot.trim() !== ""
}
