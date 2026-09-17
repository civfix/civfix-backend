import { describe, it, expect } from "vitest"
import {
  buildReportPacket,
  buildDiscussionForwardPacket,
  buildEventPacket,
} from "../../src/services/admin/mail-format.js"
import { eventFooter, renderEmailBody } from "../../src/adapters/email-layout.js"
import { paragraph, kvTable, linkList } from "../../src/adapters/email-blocks.js"
import { renderOtp, renderTemplate } from "../../src/adapters/mailer.oci.js"
import { buildDataExportEmail } from "../../src/services/data-export-service.js"
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
    previewMedia: null,
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
    expect(packet.subject).toBe("[civfix] Tag on the underpass - Springfield - ABC123")
    expect(packet.html).toContain("<!DOCTYPE html>")
    expect(packet.html).toContain("First line of description.<br>Second line with detail.")
    expect(packet.html).toContain(">Photo 1<")
    expect(packet.html).toContain(">Photo 2<")
    expect(packet.html).toContain("Please prioritize.")
    expect(packet.text).toContain("civfix reference ABC123")
    expect(packet.text).not.toContain("11111111-2222-3333-4444-555555555555")
    expect(packet.text).toContain("Photo 1: https://r2/a?t=1")
    expect(packet.text).toContain("3 neighbors")
  })

  it("H6: the packet never names the reporter and never offers a direct line to them", () => {
    const packet = buildReportPacket(reportRecord(), null, [], null)
    for (const part of [packet.text, packet.html]) {
      expect(part).not.toContain("Dana Reporter")
      expect(part).not.toContain("Reported by")
      expect(part.toLowerCase()).not.toContain("directly to the resident")
      expect(part.toLowerCase()).not.toContain("to reach the resident")
    }
    expect(packet.text).toContain("Replies to this email go to the civfix operators")
    expect(packet.text).toContain("replies to this email reach the civfix operators")
  })

  it("H6: precise coordinates and the map link stay (jurisdiction routing needs the exact spot)", () => {
    const packet = buildReportPacket(reportRecord(), null, [], null)
    expect(packet.text).toContain("39.5, -98.35")
    expect(packet.html).toContain("mlat=39.5")
    expect(packet.text).toContain("100 Main St")
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
    expect(packet.html).toContain("A Graffiti report was filed at 100 Main St.")
    expect(packet.html).toContain("Confirmed by 3 neighbors.")
    expect(packet.html).toContain("<!DOCTYPE html>")
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
    expect(packet.html).toContain("First paragraph.")
    expect(packet.html).toContain("Second paragraph.")
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

describe("footer rendering", () => {
  it("splits the event footer into lines and links its URLs in the HTML part", () => {
    const footer = eventFooter({
      eventTitle: "Beach Cleanup",
      unsubscribeUrl: "https://civfix.org/unsubscribe?t=abc",
      manageUrl: "https://civfix.org/e/beach",
    })
    expect(footer).toContain("\n")
    const { html, text } = renderEmailBody({ blocks: [paragraph("x")], footer })
    expect(html).toContain('href="https://civfix.org/unsubscribe?t=abc"')
    expect(html).toContain('href="https://civfix.org/e/beach"')
    expect(html).toContain("never gave them your email address.<br>")
    expect(text).toContain("Stop receiving messages about this event: https://civfix.org/unsubscribe?t=abc")
  })

  it("escapes HTML in the footer before linkifying", () => {
    const { html } = renderEmailBody({ blocks: [paragraph("x")], footer: "<b>bold</b> https://civfix.org" })
    expect(html).not.toContain("<b>bold</b>")
    expect(html).toContain("&lt;b&gt;bold&lt;/b&gt;")
    expect(html).toContain('href="https://civfix.org"')
  })
})

describe("renderOtp", () => {
  it("renders the passcode in the styled code block with a muted expiry line", () => {
    const out = renderOtp("482913", "en")
    expect(out.subject).toBe("Your civfix sign-in code")
    expect(out.html).toContain("482913")
    expect(out.html).toContain("letter-spacing:6px")
    expect(out.text).toContain("482913")
    expect(out.text).toContain("expires in 5 minutes")
  })
})

describe("renderTemplate", () => {
  it("guest_otp: shows the code in the big code block, not buried in a sentence", () => {
    const out = renderTemplate("guest_otp", { title: "Beach Cleanup", code: "738201", minutes: "5" })
    expect(out.subject).toBe("Your code to RSVP for Beach Cleanup")
    expect(out.html).toContain("letter-spacing:6px")
    expect(out.html).toContain(">738201<")
    expect(out.text).toContain("738201")
    expect(out.text).toContain("expires in 5 minutes")
  })

  it("guest_confirmed: event heading, when/where rows, honest check-in line and a cancel button", () => {
    const out = renderTemplate("guest_confirmed", {
      title: "Beach Cleanup",
      when: "Saturday, October 3 at 9:00 AM PDT",
      place: "Ballona Creek Trailhead",
      cancelUrl: "https://civfix.org/guest?token=abc",
    })
    expect(out.subject).toBe("You are on the list for Beach Cleanup")
    expect(out.html).toContain("<h2")
    expect(out.html).toContain("Beach Cleanup")
    expect(out.html).toContain("When")
    expect(out.html).toContain("Where")
    expect(out.html).toContain("Ballona Creek Trailhead")
    expect(out.html).toContain("Check in by name")
    expect(out.html).toContain('href="https://civfix.org/guest?token=abc"')
    expect(out.html).toContain(">Cancel RSVP</a>")
    expect(out.html).not.toContain(">https://civfix.org/guest?token=abc<")
    expect(out.text).toContain("Cancel RSVP: https://civfix.org/guest?token=abc")
  })

  it("guest_confirmed: omits the details table when when/where are absent", () => {
    const out = renderTemplate("guest_confirmed", {
      title: "Beach Cleanup",
      cancelUrl: "https://civfix.org/guest?token=abc",
    })
    expect(out.html).not.toContain(">When<")
    expect(out.html).toContain("Check in by name")
  })

  it("guest_promoted: intro paragraph, event button, muted opt-out line", () => {
    const out = renderTemplate("guest_promoted", {
      title: "Beach Cleanup",
      when: "Saturday at 9:00 AM",
      eventUrl: "https://civfix.org/cleanups/e1",
    })
    expect(out.subject).toBe("A place opened up for Beach Cleanup")
    expect(out.html).toContain("holding a place for you")
    expect(out.html).toContain('href="https://civfix.org/cleanups/e1"')
    expect(out.html).toContain(">See the event</a>")
    expect(out.html).toContain("nothing you need to do")
  })

  it("action: paragraphs, quote with heading, CTA button and muted note", () => {
    const out = renderTemplate("action", {
      subject: "You have been invited",
      paragraphs: ["First paragraph.", "Second paragraph."],
      quoteHeading: "Reason",
      quote: "The uploaded letter names a different entity.",
      ctaUrl: "https://civfix.org/accept#token=x",
      ctaLabel: "Accept the invitation",
      note: "The invitation expires in 14 days.",
    })
    expect(out.subject).toBe("You have been invited")
    expect(out.html).toContain("First paragraph.")
    expect(out.html).toContain("Second paragraph.")
    expect(out.html).toContain(">Reason</h2>")
    expect(out.html).toContain("different entity")
    expect(out.html).toContain('href="https://civfix.org/accept#token=x"')
    expect(out.html).toContain(">Accept the invitation</a>")
    expect(out.html).not.toContain(">https://civfix.org/accept#token=x<")
    expect(out.text).toContain("Accept the invitation: https://civfix.org/accept#token=x")
    expect(out.text).toContain("The invitation expires in 14 days.")
  })

  it("action: escapes HTML-significant user content", () => {
    const out = renderTemplate("action", {
      subject: "s",
      paragraphs: ["<script>alert(1)</script>"],
    })
    expect(out.html).not.toContain("<script>alert(1)</script>")
    expect(out.html).toContain("&lt;script&gt;")
  })

  it("action: falls back to the generic body when nothing usable is passed", () => {
    const out = renderTemplate("action", { subject: "s", paragraphs: [42, ""] })
    expect(out.html).toContain("You have a new civfix notification.")
  })

  it("unknown templates still fall back to the generic paragraph shell", () => {
    const out = renderTemplate("whatever", { subject: "Hi", message: "Body text." })
    expect(out.subject).toBe("Hi")
    expect(out.html).toContain("Body text.")
  })
})

describe("buildDataExportEmail", () => {
  it("renders the branded shell with the truncation note only when sections were clipped", () => {
    const full = buildDataExportEmail("support@civfix.org", [])
    expect(full.subject).toBe("Your civfix data export")
    expect(full.html).toContain("<!DOCTYPE html>")
    expect(full.html).toContain("civfix-export.json")
    expect(full.html).not.toContain("only part of them")

    const clipped = buildDataExportEmail("support@civfix.org", ["messages", "comments"])
    expect(clipped.html).toContain("messages, comments")
    expect(clipped.html).toContain("support@civfix.org")
    expect(clipped.text).toContain("If you did not request this, you can ignore this email.")
  })
})
