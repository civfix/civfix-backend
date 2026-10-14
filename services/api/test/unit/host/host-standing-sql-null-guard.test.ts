import { describe, expect, it } from "vitest"
import { findParamNullTests } from "../../../../../scripts/check-dynamic-sql.mjs"

describe("check:sql: uncast parameter in a NULL test", () => {
  it("flags a bare interpolated parameter used as a NULL test", () => {
    const found = findParamNullTests(
      "sql`LEFT JOIN cleanup_members m ON m.cleanup_id = c.id AND ${userId} IS NOT NULL`",
    )
    expect(found).toEqual(["${userId} IS NOT NULL"])
  })

  it("flags the IS NULL spelling and multi-line formatting", () => {
    const found = findParamNullTests("sql`WHERE ${a} IS NULL\n  AND ${b}\n  IS NOT NULL`")
    expect(found).toEqual(["${a} IS NULL", "${b} IS NOT NULL"])
  })

  it("accepts an explicitly cast parameter", () => {
    expect(
      findParamNullTests(
        "sql`WHERE (${claimantUserId}::uuid IS NULL OR u.id <> ${claimantUserId}::uuid)`",
      ),
    ).toEqual([])
    expect(findParamNullTests("sql`WHERE ${ids}::uuid[] IS NOT NULL`")).toEqual([])
  })

  it("accepts the identifier helper, which interpolates a name and not a parameter", () => {
    expect(findParamNullTests("tx`AND ${tx(column)} IS NULL`")).toEqual([])
  })

  it("holds over the shipped host-standing join", () => {
    expect(
      findParamNullTests(
        "sql`LEFT JOIN cleanup_members m ON m.cleanup_id = c.id AND m.user_id = ${userId}::uuid`",
      ),
    ).toEqual([])
  })
})
