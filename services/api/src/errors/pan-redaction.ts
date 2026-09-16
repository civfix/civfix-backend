const PAN_RE = /\b(?:\d[ -]*?){13,19}\b/g

export function isLuhnValid(candidate: string): boolean {
  const digits = candidate.replace(/\D/g, "")
  if (digits.length < 13 || digits.length > 19) return false
  let sum = 0
  let doubled = false
  for (let position = digits.length - 1; position >= 0; position -= 1) {
    let value = digits.charCodeAt(position) - 48
    if (doubled) {
      value *= 2
      if (value > 9) value -= 9
    }
    sum += value
    doubled = !doubled
  }
  return sum % 10 === 0
}

export function redactPans(text: string, replacement: string): string {
  return text.replace(PAN_RE, (match) => (isLuhnValid(match) ? replacement : match))
}
