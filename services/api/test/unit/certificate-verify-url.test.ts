import { afterEach, describe, expect, it, vi } from "vitest"
import PDFDocument from "pdfkit"
import { FakeStorage } from "@civfix/shared/fakes"
import { InMemoryCertificateRepository } from "../../src/services/certificate-repository.memory.js"
import { makeCertificateService } from "../../src/services/certificate-service.js"
import type { VolunteerHoursEntryView } from "../../src/services/volunteer-hours-service.js"

const qrPayloads = vi.hoisted(() => [] as string[])

vi.mock("qrcode-generator", async (importOriginal) => {
  const actual = (await importOriginal()) as {
    default: (t: number, e: string) => { addData(d: string): void }
  }
  return {
    default: (typeNumber: number, level: string) => {
      const qr = actual.default(typeNumber, level)
      const addData = qr.addData.bind(qr)
      qr.addData = (data: string) => {
        qrPayloads.push(data)
        addData(data)
      }
      return qr
    },
  }
})

const USER = "11111111-1111-4111-8111-111111111111"

const ENTRY: VolunteerHoursEntryView = {
  id: "22222222-2222-4222-8222-222222222222",
  source: "event",
  hours: 2,
  createdAt: new Date("2026-06-01T18:00:00.000Z"),
  occurredAt: new Date("2026-06-01T17:00:00.000Z"),
  cleanupId: "33333333-3333-4333-8333-333333333333",
  cleanupTitle: "Beach cleanup",
  cleanupReferenceCode: null,
  reportId: null,
  jurisdictionGeoid: "0644000",
  jurisdictionName: "Los Angeles",
  creditedBy: {
    id: "44444444-4444-4444-8444-444444444444",
    name: "Ada",
    handle: null,
    organization: null,
  },
}

function textsWritten(): string[] {
  const written: string[] = []
  vi.spyOn(PDFDocument.prototype, "text").mockImplementation(function (
    this: PDFKit.PDFDocument,
    text: unknown,
  ) {
    written.push(String(text))
    return this
  })
  return written
}

afterEach(() => {
  vi.restoreAllMocks()
  qrPayloads.length = 0
})

describe("certificate verify link follows the deployment's web origin", () => {
  it("encodes the staging origin in the QR and prints it in the footer", async () => {
    const written = textsWritten()
    const certs = new InMemoryCertificateRepository()
    certs.setHolder(USER, { displayName: "Jane Doe", handle: "jane" })
    const service = makeCertificateService({
      repo: certs,
      hours: {
        entriesForCertificate: () =>
          Promise.resolve({ items: [ENTRY], totalHours: 2, entryCount: 1 }),
      },
      storage: new FakeStorage(),
      verifyBaseUrl: "https://civfix.dev/service-record",
      mintCode: () => "A1B2C3D4E5F6",
    })

    await service.issue(USER, "en")

    expect(qrPayloads).toEqual(["https://civfix.dev/service-record/CFX-A1B2-C3D4-E5F6"])
    expect(written).toContain("civfix.dev/service-record")
    expect(written).not.toContain("civfix.org/service-record")
  })

  it("names the staging verify page in the prompt beside the QR", async () => {
    const written = textsWritten()
    await issueWith("https://civfix.dev/service-record")

    expect(written).toContain("Verify this record at civfix.dev/service-record")
    expect(written).not.toContain("Verify this record at civfix.org/service-record")
  })

  it("keeps the production prompt word for word when no base URL is wired", async () => {
    const written = textsWritten()
    await issueWith(undefined)

    expect(written).toContain("Verify this record at civfix.org/service-record")
  })
})

async function issueWith(verifyBaseUrl: string | undefined): Promise<void> {
  const certs = new InMemoryCertificateRepository()
  certs.setHolder(USER, { displayName: "Jane Doe", handle: "jane" })
  const service = makeCertificateService({
    repo: certs,
    hours: {
      entriesForCertificate: () =>
        Promise.resolve({ items: [ENTRY], totalHours: 2, entryCount: 1 }),
    },
    storage: new FakeStorage(),
    ...(verifyBaseUrl === undefined ? {} : { verifyBaseUrl }),
    mintCode: () => "A1B2C3D4E5F6",
  })
  await service.issue(USER, "en")
}
