// Unlike `??`, an empty string also falls through: blank vendor fields, headers and env vars mean
// "absent" here.
export function firstNonEmpty(...values: (string | null | undefined)[]): string | undefined {
  return values.find(
    (value): value is string => value !== undefined && value !== null && value !== "",
  )
}
