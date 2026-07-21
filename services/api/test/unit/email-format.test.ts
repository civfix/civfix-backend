import { describe, it, expect } from "vitest"
import {
  buildReportPacket,
  buildDiscussionForwardPacket,
  buildEventPacket,
} from "../../src/services/admin/mail-format.js"
import { renderEmailBody } from "../../src/adapters/email-layout.js"
import { paragraph, kvTable, linkList } from "../../src/adapters/email-blocks.js"
import type { AdminReportRecord } from "../../src/services/admin/admin-report-types.js"

function reportRecord(overrides: Partial<AdminReportRecord> = {}): AdminReportRecord {
  return {
    id: "11111111-2222-3333-4444-555555555555",
    category: "graffiti",
    status: "submitted",
    flagged: false,
    title: "Tag on the underpass",
    place: "Springfield",
    reporter: {
      id: "u1",
      name: "Dana Reporter",
      handle: "dana",
      emailVerified: true,
      hasOauth: false,
      joinedAt: new Date("2025-01-01T00:00:00Z"),
    },
    confirmations: 3,
    address: "100 Main St",
    desc: "First line of description.\nSecond line with detail.",
    lat: 39.5,
    lng: -98.35,
    hasPhoto: true,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    referenceCode: "ABC123",
    verificationVerdict: null,
    verifiedAt: null,
    reporterReportVerified: null,
    ...overrides,
  }
}

describe("email layout", () => {
  it("emits a full HTML document with charset, viewport, inline CSS and a footer", () => {
    const { html } = renderEmailBody({ blocks: [paragraph("Hello")] })
    expect(html).toContain("<!DOCTYPE html>")
    expect(html).toContain('<meta charset="utf-8">')
    expect(html).toContain("width=device-width")
    expect(html).toContain("civfix")
    expect(html).toContain("civfix.org")
    expect(html).toContain('style="')
  })

  it("converts newlines to <br> in paragraphs but keeps them in the text part", () => {
    const block = paragraph("line one\nline two")
    expect(block.html).toContain("line one<br>line two")
    expect(block.text).toBe("line one\nline two")
  })

  it("aligns key/value rows in the text part", () => {
    const block = kvTable([
      ["Title", "Pothole"],
      ["Category", "hazard"],
    ])
    expect(block.text).toContain("Title:")
    expect(block.text).toContain("Category:")
    expect(block.html).toContain("role=\"presentation\"")
  })

  it("renders photo links as labels, never raw URLs as text", () => {
    const block = linkList("Photos", [{ label: "Photo 1", href: "https://r2/secret?token=abc" }])
    expect(block.html).toContain(">Photo 1<")
    expect(block.html).toContain('href="https://r2/secret?token=abc"')
    expect(block.html).not.toContain(">https://r2/secret?token=abc<")
  })
})

describe("buildReportPacket", () => {
  it("builds the refined default subject + a branded body with escaped, multi-line content", () => {
    const packet = buildReportPacket(reportRecord(), null, ["https://r2/a?t=1", "https://r2/b?t=2"], "Please prioritize.")
    // The concise default subject identifies the report by its title, place, and human reference.
    expect(packet.subject).toBe("[civfix] Tag on the underpass - Springfield - ABC123")
    expect(packet.html).toContain("<!DOCTYPE html>")
    expect(packet.html).toContain("First line of description.<br>Second line with detail.")
    expect(packet.html).toContain(">Photo 1<")
    expect(packet.html).toContain(">Photo 2<")
    expect(packet.html).toContain("Please prioritize.")
    // The default footer paragraph uses the human reference code, not the raw UUID.
    expect(packet.text).toContain("civfix reference ABC123")
    expect(packet.text).not.toContain("11111111-2222-3333-4444-555555555555")
    expect(packet.text).toContain("Photo 1: https://r2/a?t=1")
    // The scannable kvTable carries the confirmations + submitted date.
    expect(packet.text).toContain("3 neighbors")
  })

  it("strips CRLF from the subject to block header injection", () => {
    const packet = buildReportPacket(reportRecord({ title: "Hi\r\nBcc: evil@x" }), null, [], null)
    expect(packet.subject).not.toContain("\n")
    expect(packet.subject).not.toContain("\r")
  })

  it("escapes HTML-significant characters in user content", () => {
    const packet = buildReportPacket(reportRecord({ desc: "<script>alert(1)</script>" }), null, [], null)
    expect(packet.html).not.toContain("<script>alert(1)</script>")
    expect(packet.html).toContain("&lt;script&gt;")
  })

  it("applies a custom body + subject template, interpolating report tokens", () => {
    const packet = buildReportPacket(
      reportRecord(),
      null,
      ["https://r2/a?t=1", "https://r2/b?t=2"],
      "Please prioritize.",
      "Case {referenceCode}: {category} at {address}",
      "A {category} report was filed at {address}.\n\nConfirmed by {confirmations} neighbors. See {mapLink}.",
    )
    expect(packet.subject).toBe("Case ABC123: Graffiti at 100 Main St")
    // Body is split on the blank line into two paragraph blocks, tokens replaced.
    expect(packet.html).toContain("A Graffiti report was filed at 100 Main St.")
    expect(packet.html).toContain("Confirmed by 3 neighbors.")
    expect(packet.html).toContain("<!DOCTYPE html>")
    // The refined-default kvTable / photo blocks are NOT emitted for a custom body.
    expect(packet.html).not.toContain(">Photo 1<")
  })

  it("normalizes CRLF in a custom body so Windows blank lines split into paragraphs without stray \\r", () => {
    const packet = buildReportPacket(
      reportRecord(),
      null,
      [],
      null,
      null,
      "First paragraph.\r\n\r\nSecond paragraph.",
    )
    // CRLF blank line splits into two distinct paragraphs (would stay one block if \r were left in).
    expect(packet.html).toContain("First paragraph.")
    expect(packet.html).toContain("Second paragraph.")
    // No carriage return leaks into either rendered part.
    expect(packet.text).not.toContain("\r")
    expect(packet.html).not.toContain("\r")
  })

  it("interpolates a custom template's HTML-significant tokens safely (escaped)", () => {
    const packet = buildReportPacket(
      reportRecord({ desc: "<b>bold</b>" }),
      null,
      [],
      null,
      null,
      "Details: {description}",
    )
    expect(packet.html).not.toContain("<b>bold</b>")
    expect(packet.html).toContain("&lt;b&gt;bold&lt;/b&gt;")
  })

  it("uses the custom subject but the refined default body when only the subject is set", () => {
    const packet = buildReportPacket(
      reportRecord(),
      null,
      [],
      null,
      "Ref {referenceCode}",
      null,
    )
    expect(packet.subject).toBe("Ref ABC123")
    // Default body still renders (the kvTable heading is present).
    expect(packet.html).toContain("What was reported")
  })
})

describe("buildDiscussionForwardPacket", () => {
  it("quotes the citizen comment and references the report", () => {
    const packet = buildDiscussionForwardPacket(
      { reportId: "abcdef12-0000-0000-0000-000000000000", category: "trash", place: "Oakville", org: null },
      "There is a pile on 5th Ave.",
    )
    expect(packet.subject).toBe("civfix report: trash in Oakville [abcdef12]")
    expect(packet.html).toContain("There is a pile on 5th Ave.")
    expect(packet.text).toContain("> There is a pile on 5th Ave.")
  })
})

describe("buildEventPacket", () => {
  it("includes the reference code in the subject and quotes the request", () => {
    const packet = buildEventPacket(
      {
        title: "Riverbank cleanup",
        host: "Sam Host",
        place: "Riverside",
        address: "River Rd",
        lat: 39.5,
        lng: -98.35,
        referenceCode: "EVT-9",
      },
      "We need 20 trash bags and gloves.",
    )
    expect(packet.subject).toBe("civfix event: Riverbank cleanup [EVT-9]")
    expect(packet.html).toContain("We need 20 trash bags and gloves.")
    expect(packet.text).toContain("Reference: EVT-9")
  })
})
