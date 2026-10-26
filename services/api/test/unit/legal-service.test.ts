import { describe, expect, it } from "vitest"
import { AppError } from "@civfix/contract"
import { eventConsentDocuments } from "../../src/services/legal-service.js"
import { C, V, outdatedDetails, sha } from "../helpers/legal-acceptance-fixtures.js"

function claim(termsVersion: string, disclosureVersion: string) {
  return { termsVersion, disclosureVersion }
}

function documents(terms: string, privacy: string) {
  return [
    { type: "terms", version: terms, sha256: sha(`terms@${terms}`) },
    { type: "privacy", version: privacy, sha256: sha(`privacy@${privacy}`) },
  ]
}

function refusal(run: () => unknown): AppError {
  try {
    run()
  } catch (err) {
    if (err instanceof AppError) return err
    throw err
  }
  throw new Error("the consent passed")
}

describe("event consent check (DECISIONS D7)", () => {
  it.each([
    ["2026-11-09", "2026-10-26"],
    ["2026-11-02", "2026-10-26"],
    ["2026-11-09", "2026-09-21"],
    ["2026-11-02", "2026-09-21"],
  ])("T28: terms %s and privacy %s pass with their sha256", (terms, privacy) => {
    expect(eventConsentDocuments(claim(terms, privacy), C, V)).toEqual(documents(terms, privacy))
  })

  it.each([
    ["2026-10-26", "2026-10-26"],
    ["2026-11-09", "2026-09-16"],
    ["2026-11-09", "2026-12-15"],
    ["2026-01-01", "2026-10-26"],
  ])("T29: terms %s and privacy %s are outdated", (terms, privacy) => {
    const err = refusal(() => eventConsentDocuments(claim(terms, privacy), C, V))

    expect(err.code).toBe("CONFLICT")
    expect(err.details).toEqual(outdatedDetails(["terms", "privacy"]))
  })

  it("T30: a material current version accepts only itself", () => {
    const at = new Date("2026-11-05T00:00:00.000Z")

    expect(eventConsentDocuments(claim("2026-11-02", "2026-10-26"), at, V)).toEqual(
      documents("2026-11-02", "2026-10-26"),
    )
    const err = refusal(() => eventConsentDocuments(claim("2026-10-26", "2026-10-26"), at, V))
    expect(err.code).toBe("CONFLICT")
    expect(err.details).toEqual(
      outdatedDetails(["terms", "privacy"], {
        terms: "terms@2026-11-02",
        privacy: "privacy@2026-10-26",
      }),
    )
  })

  it("T31: a pre-§66 current version, material unknown, accepts only itself", () => {
    const at = new Date("2026-10-01T00:00:00.000Z")

    expect(eventConsentDocuments(claim("2026-09-21", "2026-09-21"), at, V)).toEqual(
      documents("2026-09-21", "2026-09-21"),
    )
    const err = refusal(() => eventConsentDocuments(claim("2026-09-16", "2026-09-21"), at, V))
    expect(err.code).toBe("CONFLICT")
    expect(err.details).toEqual(
      outdatedDetails(["terms", "privacy"], {
        terms: "terms@2026-09-21",
        privacy: "privacy@2026-09-21",
      }),
    )
  })
})
