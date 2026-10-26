import { describe, expect, it } from "vitest"
import { LEGAL_DOCUMENTS, legalDocument } from "@civfix/contract/legal"
import {
  assertConsentVersionsCurrent,
  currentLegalDocument,
} from "../../src/services/legal-service.js"

describe("event consent version check", () => {
  it("rejects a consent claiming a superseded version", () => {
    for (const type of ["terms", "privacy"] as const) {
      const current = legalDocument(type)
      const superseded = LEGAL_DOCUMENTS.find(
        (entry) => entry.type === type && entry.version !== current.version,
      )
      expect(superseded, type).toBeDefined()
      expect(currentLegalDocument(type).version).toBe(current.version)
      expect(() =>
        assertConsentVersionsCurrent([{ type, version: superseded?.version ?? "" }]),
      ).toThrow()
      expect(() => assertConsentVersionsCurrent([{ type, version: current.version }])).not.toThrow()
    }
  })
})
