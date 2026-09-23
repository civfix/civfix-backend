import { describe, it, expect } from "vitest"
import {
  buildReportPacket,
  buildDiscussionForwardPacket,
  buildEventPacket,
  NO_PHOTO_LINKS,
} from "../../src/services/admin/mail-format.js"
import { renderEmailBody } from "../../src/adapters/email-layout.js"
import { WORDMARK_FONT_WOFF2_BASE64 } from "../../src/adapters/email-wordmark-font.js"
import {
  DEFAULT_FORWARD_BODY_TEMPLATE,
  DEFAULT_FORWARD_SUBJECT_TEMPLATE,
  templateUsesToken,
} from "@civfix/shared"
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

const NO_TEMPLATES = { subject: null, body: null }

const defaultSubjectUses = (token: string): boolean =>
  templateUsesToken(DEFAULT_FORWARD_SUBJECT_TEMPLATE, token)
const defaultBodyUses = (token: string): boolean =>
  templateUsesToken(DEFAULT_FORWARD_BODY_TEMPLATE, token)

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

  it("sets the wordmark in the embedded brand font, screen-only so Outlook keeps the fallback stack", () => {
    const { html } = renderEmailBody({ blocks: [paragraph("Hello")] })
    expect(html).toMatch(
      /<style>@media screen\{@font-face\{font-family:'civfix-wordmark';[^}]*src:url\(data:font\/woff2;base64,[A-Za-z0-9+/=]+\) format\('woff2'\);\}[^<]*\}<\/style><style>@media \(max-width:600px\)/,
    )
    expect(html).toContain(`<span class="cv-wordmark" style="font-family:-apple-system,`)
    const font = Buffer.from(WORDMARK_FONT_WOFF2_BASE64, "base64")
    expect(font.subarray(0, 4).toString("latin1")).toBe("wOF2")
    expect(font.readUInt32BE(8)).toBe(font.length)
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
  it("renders the shared default templates with every token resolved and nothing left dangling", () => {
    const packet = buildReportPacket(
      reportRecord(),
      null,
      ["https://r2/a?t=1", "https://r2/b?t=2"],
      "Please prioritize.",
      NO_TEMPLATES,
    )
    expect(packet.html).toContain("<!DOCTYPE html>")
    expect(packet.subject).toContain("ABC123")
    expect(packet.subject).toContain("Tag on the underpass")
    expect(packet.subject).not.toMatch(/\{[A-Za-z]+\}/)
    expect(packet.text).not.toMatch(/\{[A-Za-z]+\}/)
    if (defaultBodyUses("referenceCode")) expect(packet.text).toContain("ABC123")
    expect(`${packet.subject}\n${packet.text}`).toContain("ABC123")
    expect(packet.text).toContain("Please prioritize.")
    if (defaultBodyUses("description")) {
      expect(packet.html).toContain("First line of description.<br>Second line with detail.")
    }
    if (defaultBodyUses("confirmations")) expect(packet.text).toContain("3")
    if (defaultSubjectUses("place")) expect(packet.subject).toContain("Springfield")
  })

  it("carries both photo links, inline when the default body renders them and as a list otherwise", () => {
    const packet = buildReportPacket(
      reportRecord(),
      null,
      ["https://r2/a?t=1", "https://r2/b?t=2"],
      null,
      NO_TEMPLATES,
    )
    if (defaultBodyUses("photoLinks")) {
      expect(packet.text).toContain("https://r2/a?t=1")
      expect(packet.text).toContain("https://r2/b?t=2")
      expect(packet.text).not.toContain("Photos (2)")
    } else {
      expect(packet.html).toContain(">Photo 1<")
      expect(packet.html).toContain(">Photo 2<")
      expect(packet.text).toContain("Photo 1: https://r2/a?t=1")
    }
    if (defaultBodyUses("photoCount")) expect(packet.text).toContain("2")
  })

  it("renders (none) for photo links when the report has no media, leaving no dangling label", () => {
    const packet = buildReportPacket(reportRecord(), null, [], null, NO_TEMPLATES)
    if (defaultBodyUses("photoLinks")) {
      expect(packet.text).toContain(NO_PHOTO_LINKS)
      expect(packet.html).toContain(NO_PHOTO_LINKS)
    }
    if (defaultBodyUses("photoCount")) expect(packet.text).toContain("0")
    expect(packet.text).not.toContain("Photos (0)")
    expect(packet.text).not.toMatch(/\{[A-Za-z]+\}/)
  })

  it("uses the real links, not the (none) placeholder, as soon as the report has media", () => {
    const packet = buildReportPacket(reportRecord(), null, ["https://r2/a?t=1"], null, NO_TEMPLATES)
    expect(packet.text).not.toContain(NO_PHOTO_LINKS)
  })

  it("H6: the packet never names the reporter and never offers a direct line to them", () => {
    const packet = buildReportPacket(reportRecord(), null, [], null, NO_TEMPLATES)
    for (const part of [packet.text, packet.html]) {
      expect(part).not.toContain("Dana Reporter")
      expect(part).not.toContain("Reported by")
      expect(part.toLowerCase()).not.toContain("directly to the resident")
      expect(part.toLowerCase()).not.toContain("to reach the resident")
    }
    expect(packet.text.toLowerCase()).toContain("replies to this email")
  })

  it("H6: precise coordinates, the address and the map link resolve (routing needs the exact spot)", () => {
    const packet = buildReportPacket(reportRecord(), null, [], null, {
      subject: null,
      body: "At {address} ({coordinates}). Map: {mapLink}",
    })
    expect(packet.text).toContain("100 Main St")
    expect(packet.text).toContain("39.5, -98.35")
    expect(packet.html).toContain("mlat=39.5")
  })

  it("strips CRLF from the subject to block header injection", () => {
    const packet = buildReportPacket(reportRecord({ title: "Hi\r\nBcc: evil@x" }), null, [], null, NO_TEMPLATES)
    expect(packet.subject).not.toContain("\n")
    expect(packet.subject).not.toContain("\r")
  })

  it("escapes HTML-significant characters in user content", () => {
    const packet = buildReportPacket(reportRecord({ desc: "<script>alert(1)</script>" }), null, [], null, NO_TEMPLATES)
    expect(packet.html).not.toContain("<script>alert(1)</script>")
    expect(packet.html).toContain("&lt;script&gt;")
  })

  it("applies a custom body + subject template, interpolating report tokens", () => {
    const packet = buildReportPacket(reportRecord(), null, [], "Please prioritize.", {
      subject: "Case {referenceCode}: {category} at {address}",
      body: "A {category} report was filed at {address}.\n\nConfirmed by {confirmations} neighbors. See {mapLink}.",
    })
    expect(packet.subject).toBe("Case ABC123: Graffiti at 100 Main St")
    expect(packet.html).toContain("A Graffiti report was filed at 100 Main St.")
    expect(packet.html).toContain("Confirmed by 3 neighbors.")
    expect(packet.html).toContain("<!DOCTYPE html>")
  })

  it("appends the photo list to a custom body that does NOT use {photoLinks}", () => {
    const packet = buildReportPacket(
      reportRecord(),
      null,
      ["https://r2/a?t=1", "https://r2/b?t=2"],
      null,
      { subject: null, body: "A {category} report was filed at {address}." },
    )
    expect(packet.html).toContain(">Photo 1<")
    expect(packet.html).toContain(">Photo 2<")
    expect(packet.text).toContain("Photos (2)")
  })

  it("does NOT append the photo list when the body already renders {photoLinks}", () => {
    const packet = buildReportPacket(
      reportRecord(),
      null,
      ["https://r2/a?t=1", "https://r2/b?t=2"],
      null,
      { subject: null, body: "Photos:\n{photoLinks}" },
    )
    expect(packet.html).not.toContain(">Photo 1<")
    expect(packet.text).toContain("https://r2/a?t=1")
  })

  it("appends the operator note as a bare quote, with no heading, unless the body renders {operatorNote}", () => {
    const appended = buildReportPacket(reportRecord(), null, [], "Please prioritize.", {
      subject: null,
      body: "A {category} report was filed.",
    })
    expect(appended.text).toContain("> Please prioritize.")
    expect(appended.text).not.toContain("Note from the civfix team")
    expect(appended.html).not.toContain("Note from the civfix team")

    const inline = buildReportPacket(reportRecord(), null, [], "Please prioritize.", {
      subject: null,
      body: "A {category} report was filed.\n\nOperator: {operatorNote}",
    })
    expect(inline.text).toContain("Operator: Please prioritize.")
    expect(inline.text).not.toContain("> Please prioritize.")
  })

  it("normalizes CRLF in a custom body so Windows blank lines split into paragraphs without stray \\r", () => {
    const packet = buildReportPacket(reportRecord(), null, [], null, {
      subject: null,
      body: "First paragraph.\r\n\r\nSecond paragraph.",
    })
    expect(packet.html).toContain("First paragraph.")
    expect(packet.html).toContain("Second paragraph.")
    expect(packet.text).not.toContain("\r")
    expect(packet.html).not.toContain("\r")
  })

  it("interpolates a custom template's HTML-significant tokens safely (escaped)", () => {
    const packet = buildReportPacket(reportRecord({ desc: "<b>bold</b>" }), null, [], null, {
      subject: null,
      body: "Details: {description}",
    })
    expect(packet.html).not.toContain("<b>bold</b>")
    expect(packet.html).toContain("&lt;b&gt;bold&lt;/b&gt;")
  })

  it("uses the custom subject but the built-in default body when only the subject is set", () => {
    const packet = buildReportPacket(reportRecord(), null, [], null, {
      subject: "Ref {referenceCode}",
      body: null,
    })
    const builtin = buildReportPacket(reportRecord(), null, [], null, NO_TEMPLATES)
    expect(packet.subject).toBe("Ref ABC123")
    expect(packet.text).toBe(builtin.text)
    expect(packet.html).toBe(builtin.html)
  })

  it("a null template renders exactly what the shared built-in default renders", () => {
    const fallback = buildReportPacket(reportRecord(), null, [], null, NO_TEMPLATES)
    const explicit = buildReportPacket(reportRecord(), null, [], null, {
      subject: null,
      body: DEFAULT_FORWARD_BODY_TEMPLATE,
    })
    expect(explicit.text).toBe(fallback.text)
    expect(explicit.html).toBe(fallback.html)
  })

  it("H6: a CUSTOM body can never name the reporter (the token is gone from the palette)", () => {
    const packet = buildReportPacket(
      reportRecord(),
      null,
      ["https://r2/a?t=1"],
      "Please prioritize.",
      { subject: "{reporterName}", body: "Filed by {reporterName} ({dept})." },
    )
    for (const part of [packet.subject, packet.text, packet.html]) {
      expect(part).not.toContain("Dana Reporter")
    }
  })

  it("strips retired or unknown tokens that survive interpolation instead of mailing them", () => {
    const packet = buildReportPacket(reportRecord(), null, [], null, {
      subject: "Ref {referenceCode} from {reporterName}",
      body: "Dept: {dept}\nTitle: {title} {{title}} {nope}",
    })
    expect(packet.subject).toBe(`Ref ${reportRecord().referenceCode} from `)
    expect(packet.text).not.toMatch(/\{[a-zA-Z]+\}/)
    expect(packet.text).not.toContain("{{")
    expect(packet.text).toContain("Dept: ")
    expect(packet.text).toContain(`Title: ${reportRecord().title}`)
    const resident = buildReportPacket(
      reportRecord({ desc: "Trash here {{ and the pile keeps growing {corner} {title} end" }),
      null,
      [],
      "Note with {braces} kept",
      NO_TEMPLATES,
    )
    expect(resident.text).toContain("Trash here {{ and the pile keeps growing {corner} {title} end")
    expect(resident.text).toContain("Note with {braces} kept")
  })

  it("links bare URLs inside template paragraphs so a rendered map link is clickable", () => {
    const packet = buildReportPacket(reportRecord(), null, [], null, {
      subject: null,
      body: "Map: {mapLink}",
    })
    expect(packet.html).toMatch(/<a class="cv-link" href="https:\/\/www\.openstreetmap\.org\/\?mlat=/)
    const custom = buildReportPacket(reportRecord(), null, [], null, {
      subject: null,
      body: "See https://example.org/x?a=1&b=2. Then <b>plain</b>",
    })
    expect(custom.html).toContain('href="https://example.org/x?a=1&amp;b=2"')
    expect(custom.html).toContain("&lt;b&gt;plain&lt;/b&gt;")
    expect(custom.html).not.toContain("<b>plain</b>")
  })

  it("renders the operator-facing status LABEL, not the raw enum value", () => {
    const packet = buildReportPacket(reportRecord({ status: "in_progress" }), null, [], null, {
      subject: null,
      body: "Status: {status}",
    })
    expect(packet.text).toContain("Status: In progress")
    expect(packet.text).not.toContain("in_progress")
  })
})

describe("buildDiscussionForwardPacket", () => {
  const input = {
    reportId: "abcdef12-0000-0000-0000-000000000000",
    category: "trash",
    place: "Oakville",
    org: null,
  }

  it("quotes the citizen comment and references the report", () => {
    const packet = buildDiscussionForwardPacket(input, "There is a pile on 5th Ave.")
    expect(packet.subject).toBe("civfix report: trash in Oakville [abcdef12]")
    expect(packet.html).toContain("There is a pile on 5th Ave.")
    expect(packet.text).toContain("> There is a pile on 5th Ave.")
  })

  it("names the commenter in the lede when a public display name is supplied", () => {
    const packet = buildDiscussionForwardPacket(
      { ...input, displayName: "Dana Neighbor" },
      "Still not cleared.",
    )
    expect(packet.text).toContain("Dana Neighbor commented on a trash report in Oakville via civfix")
    expect(packet.text).not.toContain("A neighbor commented")
    expect(packet.text).toContain("> Still not cleared.")
  })

  it("falls back to the anonymous lede for a blank, null or deleted-author name", () => {
    for (const displayName of [null, undefined, "", "   "]) {
      const packet = buildDiscussionForwardPacket({ ...input, displayName }, "hi")
      expect(packet.text).toContain("A neighbor commented on a trash report in Oakville via civfix")
    }
    const deleted = buildDiscussionForwardPacket({ ...input, displayName: "Deleted User" }, "hi")
    expect(deleted.text).toContain("Deleted User commented on a trash report in Oakville via civfix")
  })

  it("escapes a display name that carries HTML-significant characters", () => {
    const packet = buildDiscussionForwardPacket(
      { ...input, displayName: "<b>Mal</b>" },
      "look at this",
    )
    expect(packet.html).not.toContain("<b>Mal</b>")
    expect(packet.html).toContain("&lt;b&gt;Mal&lt;/b&gt;")
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
