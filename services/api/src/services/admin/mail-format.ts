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

/** The fields buildDiscussionForwardPacket reads off a report being @jurisdiction-forwarded (D11). */
export interface DiscussionForwardInput {
  reportId: string
  category: string
  place: string | null
  org: string | null
}

/**
 * Build the packet for a citizen's @jurisdiction-mentioned discussion comment forwarded to the city (D11):
 * a subject `civfix report: {category} in {place} [{id8}]` and a body QUOTING the comment, so the city's
 * reply threads back onto the REPORT (via the per-report thread). Mirrors buildReportPacket's professional
 * tone + injection guards (HTML-escape every value; CR/LF-strip + clamp the subject).
 */
export function buildDiscussionForwardPacket(
  input: DiscussionForwardInput,
  comment: string,
): ReportPacket {
  const id8 = input.reportId.slice(0, 8)
  const place = input.place ?? input.org ?? "the area"
  const safeSubject = sanitizeHeaderValue(`${input.category} in ${place}`)
  const subject = `civfix report: ${safeSubject} [${id8}]`
  const body = comment.trim()

  const text = [
    `A neighbor commented on a ${input.category} report in ${place} via civfix and mentioned your office.`,
    "",
    "Their comment:",
    body !== "" ? body : "(no comment provided)",
    "",
    `Reference: ${input.reportId}`,
    "Reply to this email to respond on the report.",
  ].join("\n")

  const html =
    `<p>A neighbor commented on a <strong>${escapeHtml(input.category)}</strong> report in ` +
    `${escapeHtml(place)} via civfix and mentioned your office.</p>` +
    `<p><strong>Their comment:</strong></p>` +
    `<blockquote>${escapeHtml(body !== "" ? body : "(no comment provided)")}</blockquote>` +
    `<p>Reference: ${escapeHtml(input.reportId)}<br>Reply to this email to respond on the report.</p>`
  return { subject, text, html }
}

/** The fields buildEventPacket reads off a cleanup (event) — a structural slice of the CleanupRecord. */
export interface EventPacketInput {
  title: string
  host: string
  place: string | null
  address: string | null
  lat: number
  lng: number
  referenceCode: string | null
}

/**
 * Build the resource-request packet emailed to a jurisdiction for an EVENT (D19): a subject
 * `civfix event: {title} [{code}]` and a professional text + HTML body carrying the event title, host,
 * location + map link, the host's requested-resources message, the event reference code, and a "reply to
 * respond" line. Mirrors buildReportPacket's style + injection guards: every interpolated value is
 * HTML-escaped, and the subject is CR/LF-stripped + clamped (sanitizeHeaderValue) so a crafted title can
 * never inject extra mail headers.
 */
export function buildEventPacket(event: EventPacketInput, message: string): ReportPacket {
  const safeTitle = sanitizeHeaderValue(event.title)
  const ref = event.referenceCode ?? null
  const subject = ref !== null ? `civfix event: ${safeTitle} [${ref}]` : `civfix event: ${safeTitle}`
  const place = event.place ?? "the area"
  const address = event.address && event.address.trim() !== "" ? event.address : place
  const mapLink = `https://www.openstreetmap.org/?mlat=${event.lat}&mlon=${event.lng}#map=18/${event.lat}/${event.lng}`
  const msgText = message.trim()

  const textLines = [
    `An event organizer is requesting resources for a community event via civfix.`,
    "",
    `Event:    ${event.title}`,
    `Host:     ${event.host}`,
    `Location: ${address}`,
    `Map:      ${mapLink}`,
    "",
    "Request from the organizer:",
    msgText !== "" ? msgText : "(no message provided)",
  ]
  if (ref !== null) textLines.push("", `Reference: ${ref}`)
  textLines.push("Reply to this email to respond to the organizer.")
  const text = textLines.join("\n")

  const refHtml = ref !== null ? `Reference: ${escapeHtml(ref)}<br>` : ""
  const html =
    `<p>An event organizer is requesting resources for a community event via civfix.</p>` +
    `<table>` +
    `<tr><td><strong>Event</strong></td><td>${escapeHtml(event.title)}</td></tr>` +
    `<tr><td><strong>Host</strong></td><td>${escapeHtml(event.host)}</td></tr>` +
    `<tr><td><strong>Location</strong></td><td>${escapeHtml(address)}</td></tr>` +
    `<tr><td><strong>Map</strong></td><td><a href="${escapeHtml(mapLink)}">map</a></td></tr>` +
    `</table>` +
    `<p><strong>Request from the organizer:</strong><br>${escapeHtml(
      msgText !== "" ? msgText : "(no message provided)",
    )}</p>` +
    `<p>${refHtml}Reply to this email to respond to the organizer.</p>`
  return { subject, text, html }
}
