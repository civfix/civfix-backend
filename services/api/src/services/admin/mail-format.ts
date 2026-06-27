import { sanitizeHeaderValue } from "../../adapters/mail-text.js"
import {
  button,
  heading,
  kvTable,
  linkList,
  paragraph,
  quote,
} from "../../adapters/email-blocks.js"
import { CITY_FOOTER, renderEmailBody } from "../../adapters/email-layout.js"
import type { AdminReportRecord, AdminReportRoutingRecord } from "./admin-report-types.js"

export const MAX_PACKET_ATTACHMENTS = 10
export const MAX_PACKET_ATTACHMENT_BYTES = 10 * 1024 * 1024

export function attachmentFilename(r2Key: string, index: number): string {
  const tail = r2Key.split("/").pop() ?? ""
  const cleaned = tail.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "")
  if (cleaned.length > 0) return cleaned.slice(0, 120)
  return `photo-${index + 1}.jpg`
}

export interface ReportPacket {
  subject: string
  text: string
  html: string
}

function mapLinkFor(lat: number, lng: number): string {
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=18/${lat}/${lng}`
}

export function buildReportPacket(
  record: AdminReportRecord,
  routing: AdminReportRoutingRecord | null,
  mediaLinks: string[],
  note: string | null,
): ReportPacket {
  const id8 = record.id.slice(0, 8)
  const subject = `civfix report: ${sanitizeHeaderValue(record.title)} [${id8}]`
  const place = routing?.place ?? record.place
  const address = record.address && record.address.trim() !== "" ? record.address : place
  const reporter = record.reporter?.name ?? "anonymous"
  const noteText = note && note.trim() !== "" ? note.trim() : null
  const desc = record.desc && record.desc.trim() !== "" ? record.desc.trim() : "(none provided)"

  const blocks = [
    paragraph(`A neighbor reported a ${record.category} issue in ${place} via civfix.`),
    kvTable([
      ["Title", record.title],
      ["Category", record.category],
      ["Location", address],
      ["Coordinates", `${record.lat}, ${record.lng}`],
      ["Reported by", reporter],
    ]),
    button(mapLinkFor(record.lat, record.lng), "View location on map"),
    heading("Description"),
    paragraph(desc),
  ]
  if (noteText !== null) {
    blocks.push(heading("Note from the civfix operator"), quote(noteText))
  }
  if (mediaLinks.length > 0) {
    blocks.push(
      linkList(
        "Photos",
        mediaLinks.map((href, i) => ({ label: `Photo ${i + 1}`, href })),
      ),
    )
  }
  blocks.push(paragraph(`Reference: ${record.id}`, { muted: true }))

  const { text, html } = renderEmailBody({
    preheader: `A neighbor reported a ${record.category} issue in ${place}.`,
    footer: CITY_FOOTER,
    blocks,
  })
  return { subject, text, html }
}

export interface DiscussionForwardInput {
  reportId: string
  category: string
  place: string | null
  org: string | null
}

export function buildDiscussionForwardPacket(
  input: DiscussionForwardInput,
  comment: string,
): ReportPacket {
  const id8 = input.reportId.slice(0, 8)
  const place = input.place ?? input.org ?? "the area"
  const subject = `civfix report: ${sanitizeHeaderValue(`${input.category} in ${place}`)} [${id8}]`
  const body = comment.trim() !== "" ? comment.trim() : "(no comment provided)"

  const { text, html } = renderEmailBody({
    preheader: `A neighbor commented on a ${input.category} report in ${place} and mentioned your office.`,
    footer: CITY_FOOTER,
    blocks: [
      paragraph(
        `A neighbor commented on a ${input.category} report in ${place} via civfix and mentioned your office.`,
      ),
      heading("Their comment"),
      quote(body),
      paragraph(`Reference: ${input.reportId}`, { muted: true }),
    ],
  })
  return { subject, text, html }
}

export interface EventPacketInput {
  title: string
  host: string
  place: string | null
  address: string | null
  lat: number
  lng: number
  referenceCode: string | null
}

export function buildEventPacket(event: EventPacketInput, message: string): ReportPacket {
  const safeTitle = sanitizeHeaderValue(event.title)
  const ref = event.referenceCode ?? null
  const subject = ref !== null ? `civfix event: ${safeTitle} [${ref}]` : `civfix event: ${safeTitle}`
  const place = event.place ?? "the area"
  const address = event.address && event.address.trim() !== "" ? event.address : place
  const msgText = message.trim() !== "" ? message.trim() : "(no message provided)"

  const blocks = [
    paragraph("An event organizer is requesting resources for a community event via civfix."),
    kvTable([
      ["Event", event.title],
      ["Host", event.host],
      ["Location", address],
    ]),
    button(mapLinkFor(event.lat, event.lng), "View location on map"),
    heading("Request from the organizer"),
    quote(msgText),
  ]
  if (ref !== null) {
    blocks.push(paragraph(`Reference: ${ref}`, { muted: true }))
  }

  const { text, html } = renderEmailBody({
    preheader: `An event organizer is requesting resources for ${event.title}.`,
    footer: CITY_FOOTER,
    blocks,
  })
  return { subject, text, html }
}
