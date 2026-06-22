import { escapeHtml, sanitizeHeaderValue } from "../../adapters/mail-text.js"
import type { AdminReportRecord, AdminReportRoutingRecord } from "./admin-report-types.js"

/** Max binary photo attachments on a routed packet (the rest are linked). */
export const MAX_PACKET_ATTACHMENTS = 10
/** Max bytes for ONE routed-packet attachment (larger images are linked, not buffered). */
export const MAX_PACKET_ATTACHMENT_BYTES = 10 * 1024 * 1024

/** Derive a safe image filename from an r2 key (last path segment), falling back to a numbered name. */
export function attachmentFilename(r2Key: string, index: number): string {
  const tail = r2Key.split("/").pop() ?? ""
  const cleaned = tail.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "")
  if (cleaned.length > 0) return cleaned.slice(0, 120)
  return `photo-${index + 1}.jpg`
}

/** The rendered outreach packet: subject + a plain-text body and an HTML body (links + the operator note). */
export interface ReportPacket {
  subject: string
  text: string
  html: string
}

/**
 * Build the report packet emailed to a jurisdiction: a subject `civfix report: {title} [{id8}]` and a
 * text + HTML body carrying the report's title, category, address, coordinates + a map link, description,
 * the optional operator note, the reporter label (or "anonymous"), and the presigned photo links. Pure
 * (no IO) so it is unit-testable. The HTML escapes every interpolated value (a report title/description is
 * attacker-adjacent user content); the title is CR/LF-stripped + clamped before the subject so it cannot
 * inject extra mail headers (SMTP header injection — has bitten the OCI From/Reply-To path in prod).
 */
export function buildReportPacket(
  record: AdminReportRecord,
  routing: AdminReportRoutingRecord | null,
  mediaLinks: string[],
  note: string | null,
): ReportPacket {
  const id8 = record.id.slice(0, 8)
  const safeTitle = sanitizeHeaderValue(record.title)
  const subject = `civfix report: ${safeTitle} [${id8}]`
  const place = routing?.place ?? record.place
  const address = record.address && record.address.trim() !== "" ? record.address : place
  const mapLink = `https://www.openstreetmap.org/?mlat=${record.lat}&mlon=${record.lng}#map=18/${record.lat}/${record.lng}`
  const reporter = record.reporter?.name ?? "anonymous"
  const noteText = note && note.trim() !== "" ? note.trim() : null

  const textLines = [
    `A neighbor reported a ${record.category} issue in ${place} via civfix.`,
    "",
    `Title:       ${record.title}`,
    `Category:    ${record.category}`,
    `Location:    ${address}`,
    `Coordinates: ${record.lat}, ${record.lng}`,
    `Map:         ${mapLink}`,
    "",
    "Description:",
    record.desc && record.desc.trim() !== "" ? record.desc.trim() : "(none provided)",
    "",
    `Reported by: ${reporter}`,
  ]
  if (noteText !== null) {
    textLines.push("", "Note from the civfix operator:", noteText)
  }
  if (mediaLinks.length > 0) {
    textLines.push("", "Photos:")
    for (const link of mediaLinks) textLines.push(link)
  }
  textLines.push("", `Reference: ${record.id}`, "Reply to this email to respond on the report.")
  const text = textLines.join("\n")

  const photosHtml =
    mediaLinks.length > 0
      ? `<p><strong>Photos:</strong></p><ul>${mediaLinks
          .map((l) => `<li><a href="${escapeHtml(l)}">${escapeHtml(l)}</a></li>`)
          .join("")}</ul>`
      : ""
  const noteHtml =
    noteText !== null
      ? `<p><strong>Note from the civfix operator:</strong><br>${escapeHtml(noteText)}</p>`
      : ""
  const html =
    `<p>A neighbor reported a <strong>${escapeHtml(record.category)}</strong> issue in ` +
    `${escapeHtml(place)} via civfix.</p>` +
    `<table>` +
    `<tr><td><strong>Title</strong></td><td>${escapeHtml(record.title)}</td></tr>` +
    `<tr><td><strong>Category</strong></td><td>${escapeHtml(record.category)}</td></tr>` +
    `<tr><td><strong>Location</strong></td><td>${escapeHtml(address)}</td></tr>` +
    `<tr><td><strong>Coordinates</strong></td><td>${record.lat}, ${record.lng} ` +
    `(<a href="${escapeHtml(mapLink)}">map</a>)</td></tr>` +
    `<tr><td><strong>Reported by</strong></td><td>${escapeHtml(reporter)}</td></tr>` +
    `</table>` +
    `<p><strong>Description:</strong><br>${escapeHtml(
      record.desc && record.desc.trim() !== "" ? record.desc.trim() : "(none provided)",
    )}</p>` +
    noteHtml +
    photosHtml +
    `<p>Reference: ${escapeHtml(record.id)}<br>Reply to this email to respond on the report.</p>`
  return { subject, text, html }
}
