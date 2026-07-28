/**
 * The public capability printed on a service-hours transcript (P5).
 *
 * The code IS the capability: it travels on the paper the holder hands to a registrar, and the verify
 * endpoint accepts nothing else. 12 Crockford base32 symbols is 32^12 ~= 2^60, so enumeration is not a
 * threat model — but the draw still has to be a real CSPRNG draw, because a predictable code would let
 * anyone assert someone else's service record.
 *
 * The format itself (alphabet, canonicalization, the `CFX-` display prefix) lives in @civfix/shared so
 * the web verification page and the apps normalize identically; this module only mints.
 */

import { CERTIFICATE_CODE_ALPHABET, CERTIFICATE_CODE_LENGTH } from "@civfix/shared"
import { randomIntBelow } from "../auth/crypto.js"

// Re-exported so a caller never re-implements normalization/formatting locally: `CFX-` is display-only
// and stripping it unconditionally would corrupt a genuine code that begins with those (valid) symbols.
export { formatCertificateCode, normalizeCertificateCode } from "@civfix/shared"

/**
 * How many times the service may re-draw on a unique-violation of `service_hours_certificates.code`
 * before giving up. At 2^60 a single collision is already implausible; five is the "the RNG is broken"
 * bound, not a birthday-paradox bound.
 */
export const CERTIFICATE_CODE_MINT_ATTEMPTS = 5

/**
 * Mint one canonical 12-char code: `CERTIFICATE_CODE_LENGTH` independent unbiased draws over the 32-symbol
 * alphabet, via the audited rejection-sampling primitive.
 *
 * NEVER `Math.random` (not a CSPRNG) and NEVER `randomBytes(n) % 32` (modulo bias) — `randomIntBelow` is
 * the one place in this codebase that gets uniformity right, and OTP generation already relies on it.
 */
export function generateCertificateCode(): string {
  let out = ""
  for (let i = 0; i < CERTIFICATE_CODE_LENGTH; i++) {
    out += CERTIFICATE_CODE_ALPHABET[randomIntBelow(CERTIFICATE_CODE_ALPHABET.length)]
  }
  return out
}
