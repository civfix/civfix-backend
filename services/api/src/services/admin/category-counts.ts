// The counts are cast to text in SQL on purpose: postgres.js surfaces int8 without a lossless numeric
// parser, so every count in this codebase crosses the wire as text and is parsed back here.

import { ReportCategorySchema, type ReportCategory } from "@civfix/shared"

/**
 * Derived from the shared zod enum so a new category cannot be half-added. Iteration order is
 * load-bearing for the digest's contact-preference `array_position` ordering and the directory's coverage
 * label.
 */
export const ADMIN_CATEGORIES: readonly ReportCategory[] = ReportCategorySchema.options

export type CategoryCountRow = Partial<Record<`cat_${ReportCategory}`, string | null>>

// A missing aggregate row means "none", so absent or malformed reads as 0.
export function parseCount(value: string | null | undefined): number {
  const n = Number.parseInt(value ?? "0", 10)
  return Number.isNaN(n) ? 0 : n
}

export function parseCategoryCounts(
  row: CategoryCountRow | undefined,
): Partial<Record<ReportCategory, number>> {
  const counts: Partial<Record<ReportCategory, number>> = {}
  if (row === undefined) return counts
  for (const category of ADMIN_CATEGORIES) {
    const n = parseCount(row[`cat_${category}`])
    if (n > 0) counts[category] = n
  }
  return counts
}
