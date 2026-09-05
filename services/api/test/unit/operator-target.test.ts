import { describe, expect, it } from "vitest"
import { AppError } from "@civfix/shared"
import {
  OPERATOR_ROLE,
  assertTargetIsNotOperatorRole,
  isOperatorRole,
} from "../../src/auth/operator-target.js"

describe("isOperatorRole", () => {
  it("is true ONLY for the exact operator role string", () => {
    expect(isOperatorRole(OPERATOR_ROLE)).toBe(true)
    expect(OPERATOR_ROLE).toBe("operator")
  })

  it("is false for every other role, and for a missing role", () => {
    for (const role of ["user", "moderator", "admin", "gov_admin", ""]) {
      expect(isOperatorRole(role)).toBe(false)
    }
    expect(isOperatorRole(null)).toBe(false)
    expect(isOperatorRole(undefined)).toBe(false)
  })
})

describe("assertTargetIsNotOperatorRole", () => {
  it("throws FORBIDDEN naming the verb when the target is an operator", () => {
    let thrown: unknown
    try {
      assertTargetIsNotOperatorRole(OPERATOR_ROLE, "ban")
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(AppError)
    const err = thrown as AppError
    expect(err.code).toBe("FORBIDDEN")
    expect(err.httpStatus).toBe(403)
    expect(err.message).toContain("ban")
    expect(err.message).toContain("operator")
  })

  it("uses the caller's verb verbatim so each console action reads correctly", () => {
    for (const verb of ["ban", "suspend", "remove"]) {
      expect(() => assertTargetIsNotOperatorRole(OPERATOR_ROLE, verb)).toThrowError(
        new RegExp(`cannot ${verb} an operator`),
      )
    }
  })

  it("does NOT throw for a non-operator target, including an unknown/absent role", () => {
    for (const role of ["user", "moderator", "admin", "", null, undefined]) {
      expect(() => assertTargetIsNotOperatorRole(role, "ban")).not.toThrow()
    }
  })
})
