/**
 * A hidden form field real users never fill. Trimmed first so autofill stacks that round-trip whitespace
 * are not punished. The authed report-service applies the same rule inline.
 */
export function honeypotTripped(honeypot: string | undefined | null): boolean {
  if (honeypot === undefined || honeypot === null) return false
  return honeypot.trim() !== ""
}
