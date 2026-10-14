export const PG_UNIQUE_VIOLATION = "23505"

const PG_CHECK_VIOLATION = "23514"

export const PG_SERIALIZATION_FAILURE = "40001"

export const PG_DEADLOCK_DETECTED = "40P01"

export const PG_UNDEFINED_TABLE = "42P01"

export const PG_INVALID_AUTHORIZATION = "28000"

export const PG_INVALID_PASSWORD = "28P01"

export const PG_INVALID_CATALOG_NAME = "3D000"

export function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === PG_UNIQUE_VIOLATION
  )
}

interface PgErrorShape {
  code?: unknown
  constraint_name?: unknown
}

function pgErrorConstraint(err: unknown): { code: string; constraint: string } | null {
  if (typeof err !== "object" || err === null) return null
  const e = err as PgErrorShape
  if (typeof e.code !== "string") return null
  return {
    code: e.code,
    constraint: typeof e.constraint_name === "string" ? e.constraint_name : "",
  }
}

export function isUniqueViolationOn(err: unknown, ...constraints: string[]): boolean {
  const parsed = pgErrorConstraint(err)
  if (parsed === null || parsed.code !== PG_UNIQUE_VIOLATION) return false
  return constraints.length === 0 || constraints.includes(parsed.constraint)
}

export function isCheckViolationOn(err: unknown, constraint: string): boolean {
  const parsed = pgErrorConstraint(err)
  return parsed !== null && parsed.code === PG_CHECK_VIOLATION && parsed.constraint === constraint
}
