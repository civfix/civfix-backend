export type TrustProxyValue = boolean | string[]

export const DEFAULT_TRUSTED_PROXY_CIDRS: readonly string[] = [
  "127.0.0.1/8",
  "::1/128",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "fc00::/7",
]

export function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === "") return fallback
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase())
}

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

export function parseIntOr(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback
  const n = Number.parseInt(raw.trim(), 10)
  return Number.isFinite(n) ? n : fallback
}

export function parsePositiveIntOr(raw: string | undefined, fallback: number): number {
  const n = parseIntOr(raw, fallback)
  return n >= 1 ? n : fallback
}

export const SHUTDOWN_DRAIN_MS_MAX = 10_000

export function parseDrainMs(raw: string | undefined): number {
  const n = parseIntOr(raw, 0)
  if (n < 0) return 0
  return Math.min(n, SHUTDOWN_DRAIN_MS_MAX)
}

export function parseBounds(
  raw: string | undefined,
  fallback: [number, number, number, number],
): [number, number, number, number] {
  if (raw === undefined || raw.trim() === "") return fallback
  const parts = raw.split(",").map((s) => Number.parseFloat(s.trim()))
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return fallback
  return [parts[0]!, parts[1]!, parts[2]!, parts[3]!]
}

export function isCronish(raw: string | undefined): boolean {
  if (raw === undefined) return false
  const fields = raw
    .trim()
    .split(/\s+/)
    .filter((f) => f.length > 0)
  if (fields.length !== 5 && fields.length !== 6) return false
  return fields.every((f) => /^[\dA-Za-z*/,\-?#]+$/.test(f))
}

export function parseTrustProxy(raw: string | undefined): TrustProxyValue {
  if (raw === undefined) return [...DEFAULT_TRUSTED_PROXY_CIDRS]
  const value = raw.trim()
  if (value === "") return [...DEFAULT_TRUSTED_PROXY_CIDRS]

  const lower = value.toLowerCase()
  if (lower === "true") return true
  if (lower === "false") return false

  if (/^\d+$/.test(value)) return [...DEFAULT_TRUSTED_PROXY_CIDRS]

  const cidrs = value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  return cidrs.length > 0 ? cidrs : [...DEFAULT_TRUSTED_PROXY_CIDRS]
}
