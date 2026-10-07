// ISO/IEC 7812 card numbers run 13 to 19 digits.
const PAN_MIN_DIGITS = 13
const PAN_MAX_DIGITS = 19
const PAN_RE = new RegExp(`\\b(?:\\d[ -]*?){${PAN_MIN_DIGITS},${PAN_MAX_DIGITS}}\\b`, "g")
const NON_DIGIT_RE = /\D/g
const CHAR_CODE_ZERO = 48
const LUHN_MODULUS = 10
const LUHN_MAX_DIGIT = 9

function isLuhnValid(candidate: string): boolean {
  const digits = candidate.replace(NON_DIGIT_RE, "")
  if (digits.length < PAN_MIN_DIGITS || digits.length > PAN_MAX_DIGITS) return false
  let sum = 0
  let doubled = false
  for (let position = digits.length - 1; position >= 0; position -= 1) {
    let value = digits.charCodeAt(position) - CHAR_CODE_ZERO
    if (doubled) {
      value *= 2
      if (value > LUHN_MAX_DIGIT) value -= LUHN_MAX_DIGIT
    }
    sum += value
    doubled = !doubled
  }
  return sum % LUHN_MODULUS === 0
}

export function redactPans(text: string, replacement: string): string {
  return text.replace(PAN_RE, (match) => (isLuhnValid(match) ? replacement : match))
}
