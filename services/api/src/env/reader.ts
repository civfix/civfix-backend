import { z } from "zod"
import { isCronish, parsePositiveIntOr } from "./parsers.js"

const PortSchema = z.coerce.number().int().positive().max(65535)

export interface NumberRange {
  min: number
  max: number
  exclusiveMin?: boolean
}

export type EnvSource = Readonly<Record<string, string | undefined>>

// Every reader appends to the shared `errors` list instead of throwing, so one boot reports every
// misconfiguration at once.
export interface EnvReader {
  readonly source: EnvSource
  readonly errors: string[]
  readonly isProd: boolean
  trimmed(key: string): string
  requiredString(key: string, opts?: { gatedOff?: boolean }): string
  port(key: string, fallback: number): number
  boundedNumber(key: string, fallback: number, range: NumberRange): number
  positiveInt(key: string, fallback: number): number
  cron(key: string, fallback: string): string
}

export function makeEnvReader(source: EnvSource, errors: string[], isProd: boolean): EnvReader {
  function trimmed(key: string): string {
    return (source[key] ?? "").trim()
  }

  function requiredString(key: string, opts: { gatedOff?: boolean } = {}): string {
    const value = trimmed(key)
    const required = isProd && !(opts.gatedOff ?? false)
    if (value.length === 0 && required) {
      errors.push(`${key}: required [BOOT] variable is missing`)
    }
    return value
  }

  function port(key: string, fallback: number): number {
    const raw = source[key]
    if (raw === undefined || raw === "") return fallback
    const parsed = PortSchema.safeParse(raw)
    if (!parsed.success) {
      errors.push(`${key}: must be an integer between 1 and 65535`)
      return fallback
    }
    return parsed.data
  }

  function boundedNumber(key: string, fallback: number, range: NumberRange): number {
    const raw = source[key]
    if (raw === undefined || raw.trim() === "") return fallback

    const exclusiveMin = range.exclusiveMin ?? false
    const value = Number.parseFloat(raw.trim())
    const aboveMin = exclusiveMin ? value > range.min : value >= range.min
    if (Number.isFinite(value) && aboveMin && value <= range.max) return value

    const lowerBound = exclusiveMin ? `greater than ${range.min}` : `at least ${range.min}`
    errors.push(`${key}: must be a number ${lowerBound} and at most ${range.max}`)
    return fallback
  }

  function positiveInt(key: string, fallback: number): number {
    return parsePositiveIntOr(source[key], fallback, { key, errors })
  }

  function cron(key: string, fallback: string): string {
    const value = trimmed(key) || fallback
    if (!isCronish(value)) {
      errors.push(`${key}: must be a 5- or 6-field cron expression`)
    }
    return value
  }

  return { source, errors, isProd, trimmed, requiredString, port, boundedNumber, positiveInt, cron }
}
