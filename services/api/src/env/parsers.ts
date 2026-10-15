export type TrustProxyValue = boolean | string[]

export const DEFAULT_TRUSTED_PROXY_CIDRS: readonly string[] = [
  "127.0.0.1/8",
  "::1/128",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "fc00::/7",
]

const TRUTHY_FORMS = new Set(["1", "true", "yes", "on"])

export function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === "") return fallback
  return TRUTHY_FORMS.has(raw.trim().toLowerCase())
}

// The single-letter forms are accepted because deployed boxes already hold one-character values for
// strict flags, and a boot failure over an unambiguous spelling would take the API down on deploy.
const STRICT_TRUE_FORMS = ["true", "t", "yes", "y", "on", "1"]
const STRICT_FALSE_FORMS = ["false", "f", "no", "n", "off", "0"]
const STRICT_TRUE = new Set(STRICT_TRUE_FORMS)
const STRICT_FALSE = new Set(STRICT_FALSE_FORMS)

export const STRICT_BOOL_ACCEPTED_FORMS = `${STRICT_TRUE_FORMS.join("/")} or ${STRICT_FALSE_FORMS.join("/")}`

export function parseStrictBool(raw: string): boolean | undefined {
  const value = raw.trim().toLowerCase()
  if (STRICT_TRUE.has(value)) return true
  if (STRICT_FALSE.has(value)) return false
  return undefined
}

export interface EnvIssueSink {
  key: string
  errors: string[]
}

const INTEGER_PATTERN = /^-?\d+$/
const UNSIGNED_INTEGER_PATTERN = /^\d+$/
const CRON_FIELD_PATTERN = /^[\dA-Za-z*/,\-?#]+$/
const CRON_FIELD_COUNTS = new Set([5, 6])
const BOUNDS_PART_COUNT = 4

export function parseCsv(raw: string | undefined): string[] {
  if (!raw) return []
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

export function parseCsvLower(raw: string | undefined): string[] {
  const seen = new Set<string>()
  for (const item of parseCsv(raw)) {
    seen.add(item.toLowerCase())
  }
  return [...seen]
}

export function parseIntOr(raw: string | undefined, fallback: number, sink?: EnvIssueSink): number {
  if (raw === undefined || raw.trim() === "") return fallback
  const value = raw.trim()
  if (!INTEGER_PATTERN.test(value)) {
    sink?.errors.push(`${sink.key}: must be an integer`)
    return fallback
  }
  return Number.parseInt(value, 10)
}

export function parsePositiveIntOr(
  raw: string | undefined,
  fallback: number,
  sink?: EnvIssueSink,
): number {
  const n = parseIntOr(raw, fallback, sink)
  if (n >= 1) return n
  sink?.errors.push(`${sink.key}: must be a positive integer`)
  return fallback
}

export const SHUTDOWN_DRAIN_MS_MAX = 10_000

// Deliberately lenient (leading digits, as parseInt reads them) unlike every other integer: a boot
// failure over shutdown timing is worse than draining for the digits the operator plainly meant.
export function parseDrainMs(raw: string | undefined): number {
  const n = Number.parseInt((raw ?? "").trim(), 10)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.min(n, SHUTDOWN_DRAIN_MS_MAX)
}

export function parseBounds(
  raw: string | undefined,
  fallback: [number, number, number, number],
): [number, number, number, number] {
  if (raw === undefined || raw.trim() === "") return fallback
  const parts = raw.split(",").map((s) => Number.parseFloat(s.trim()))
  if (parts.length !== BOUNDS_PART_COUNT || parts.some((n) => !Number.isFinite(n))) return fallback
  return [parts[0]!, parts[1]!, parts[2]!, parts[3]!]
}

export function isCronish(raw: string | undefined): boolean {
  if (raw === undefined) return false
  const fields = raw
    .trim()
    .split(/\s+/)
    .filter((f) => f.length > 0)
  if (!CRON_FIELD_COUNTS.has(fields.length)) return false
  return fields.every((f) => CRON_FIELD_PATTERN.test(f))
}

export function parseTrustProxy(raw: string | undefined): TrustProxyValue {
  if (raw === undefined) return [...DEFAULT_TRUSTED_PROXY_CIDRS]
  const value = raw.trim()
  if (value === "") return [...DEFAULT_TRUSTED_PROXY_CIDRS]

  const lower = value.toLowerCase()
  if (lower === "true") return true
  if (lower === "false") return false

  if (UNSIGNED_INTEGER_PATTERN.test(value)) return [...DEFAULT_TRUSTED_PROXY_CIDRS]

  const cidrs = value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  return cidrs.length > 0 ? cidrs : [...DEFAULT_TRUSTED_PROXY_CIDRS]
}
