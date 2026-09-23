import { afterEach, describe, expect, it, vi } from "vitest"
import PDFDocument from "pdfkit"
import {
  buildTranscriptModel,
  type CertificateTranslator,
} from "../../src/services/certificate-model.js"
import { buildServiceHoursPdf } from "../../src/services/certificate-pdf.js"

const t: CertificateTranslator = (key) => key

const HOLDER = {
  userId: "11111111-1111-4111-8111-111111111111",
  displayName: "Jane Doe",
  handle: "jane",
  verified: true,
}

async function sealTextFor(issuedAt: Date): Promise<string[]> {
  const written: string[] = []
  vi.spyOn(PDFDocument.prototype, "text").mockImplementation(function (
    this: PDFKit.PDFDocument,
    text: unknown,
  ) {
    written.push(String(text))
    return this
  })
  const model = buildTranscriptModel({ holder: HOLDER, locale: "en", t, rows: [] })
  await buildServiceHoursPdf({ model, code: "A1B2C3D4E5F6", issuedAt, t })
  return written
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("certificate seal year", () => {
  it("prints the year of the Pacific issue date, not the UTC year, on New Year's Eve evening", async () => {
    const written = await sealTextFor(new Date("2027-01-01T07:30:00.000Z"))

    expect(written).toContain("2026")
    expect(written).not.toContain("2027")
  })

  it("prints the new year once it is New Year's Day in Pacific time", async () => {
    const written = await sealTextFor(new Date("2027-01-01T08:30:00.000Z"))

    expect(written).toContain("2027")
  })
})
