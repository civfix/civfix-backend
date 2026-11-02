import { describe, expect, it } from "vitest"
import { buildReportPacket } from "../../src/services/admin/mail-format.js"
import type { AdminReportRecord } from "../../src/services/admin/admin-report-repository.js"

const RECORD: AdminReportRecord = {
  id: "11111111-2222-3333-4444-555555555555",
  category: "graffiti",
  status: "published",
  visibility: "public",
  flagged: false,
  title: "Tag on the underpass",
  place: "Springfield",
  reporter: null,
  confirmations: 0,
  address: "100 Main St",
  desc: "Fresh tag.",
  lat: 39.5,
  lng: -98.35,
  hasPhoto: true,
  previewMedia: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  referenceCode: "ABC123",
  verificationVerdict: null,
  verifiedAt: null,
  reporterReportVerified: null,
}

const MEDIA = [
  { id: "m-1", kind: "image" as const, url: "https://media.test/a" },
  { id: "m-2", kind: "image" as const, url: "https://media.test/b" },
  { id: "m-3", kind: "video" as const, url: "https://media.test/c" },
]

function linkLabels(text: string): string[] {
  return [...text.matchAll(/^\s+((?:Photo|Video) \d+): https:/gm)].map((m) => m[1] as string)
}

describe("buildReportPacket: the link block", () => {
  it("E16: with no attached set (the routeReport call), every ready item is linked, as before", () => {
    const packet = buildReportPacket(RECORD, null, MEDIA, null, { subject: null, body: null })
    expect(linkLabels(packet.text)).toEqual(["Photo 1", "Photo 2", "Video 1"])
    expect(packet.text).toContain("Photos and videos (3):")
  })
})
