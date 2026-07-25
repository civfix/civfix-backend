import { sanitizeHeaderValue } from "../../adapters/mail-text.js"
import {
  button,
  heading,
  kvTable,
  linkList,
  paragraph,
  quote,
  type EmailBlock,
} from "../../adapters/email-blocks.js"
import { CITY_FOOTER, renderEmailBody } from "../../adapters/email-layout.js"
import { REPORT_CATEGORY_LABELS, interpolateForwardTemplate } from "@civfix/shared"
import type { AdminReportRecord, AdminReportRoutingRecord } from "./admin-report-types.js"

export const MAX_PACKET_ATTACHMENTS = 10
export const MAX_PACKET_ATTACHMENT_BYTES = 10 * 1024 * 1024

/** File extension per MIME type media intake accepts; the packet's last resort is .jpg. */
const ATTACHMENT_EXTENSIONS: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
}

const EXTENSION_FALLBACK = ".jpg"

/** Whether a filename already ends in something a mail client will read as an extension. */
function hasExtension(name: string): boolean {
  return /\.[A-Za-z0-9]{2,5}$/.test(name)
}

/**
 * The filename to label a routed packet attachment with.
 *
 * The r2 key carries NO extension (media intake mints opaque keys), so the derived name used to reach the
 * city's inbox extension-less — which is precisely when a mail client falls back to "unknown attachment"
 * and refuses to preview the photo the packet exists to deliver. `contentType` is the already-resolved MIME
 * (admin-report-service.ts:attachmentContentType sniffs it from the bytes, since no MIME is stored), so the
 * extension and the Content-Type header can never disagree. A key tail that already carries an extension is
 * left alone.
 */
export function attachmentFilename(r2Key: string, index: number, contentType?: string): string {
  const ext =
    ATTACHMENT_EXTENSIONS[(contentType ?? "").trim().toLowerCase()] ?? EXTENSION_FALLBACK
  const tail = r2Key.split("/").pop() ?? ""
  const cleaned = tail.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "")
  if (cleaned.length === 0) return `photo-${index + 1}${ext}`
  if (hasExtension(cleaned)) return cleaned.slice(0, 120)
  // Truncate the BASE so the extension always survives the 120-char cap.
  return `${cleaned.slice(0, 120 - ext.length)}${ext}`
}

export interface ReportPacket {
  subject: string
  text: string
  html: string
}

function mapLinkFor(lat: number, lng: number): string {
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=18/${lat}/${lng}`
}

/** Format a report's created_at into a human "Submitted" date (e.g. "July 20, 2026"). */
function formatSubmittedDate(d: Date): string {
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })
}

/**
 * Build the full token->value map for the per-jurisdiction custom forward template (the 21
 * FORWARD_TEMPLATE_VARIABLES, keyed by BARE name). interpolateForwardTemplate replaces `{token}` with
 * `values[bareName] ?? ""`, so an unavailable value renders as an empty string (never the literal token).
 */
function buildTemplateValues(
  record: AdminReportRecord,
  routing: AdminReportRoutingRecord | null,
  mediaLinks: string[],
  noteText: string | null,
): Record<string, string> {
  const ref = record.referenceCode ?? record.id.slice(0, 8)
  const categoryLabel = REPORT_CATEGORY_LABELS[record.category]
  const place = routing?.place ?? record.place
  const address = record.address && record.address.trim() !== "" ? record.address : place
  const desc = record.desc && record.desc.trim() !== "" ? record.desc.trim() : ""
  return {
    referenceCode: ref,
    reportId: record.id,
    shortId: record.id.slice(0, 8),
    title: record.title,
    category: categoryLabel,
    status: record.status,
    place,
    address,
    coordinates: `${record.lat}, ${record.lng}`,
    lat: String(record.lat),
    lng: String(record.lng),
    mapLink: mapLinkFor(record.lat, record.lng),
    description: desc,
    reporterName: record.reporter?.name ?? "anonymous",
    confirmations: String(record.confirmations),
    submittedDate: formatSubmittedDate(record.createdAt),
    jurisdictionName: routing?.place ?? place,
    dept: routing?.dept ?? "",
    operatorNote: noteText ?? "",
    photoLinks: mediaLinks.join("\n"),
    photoCount: String(mediaLinks.length),
  }
}

/**
 * The report -> jurisdiction email, used by BOTH the manual Approve & send route and the auto-forward job.
 *
 * By default it renders the refined civfix packet (a scannable card + map button + description + photos).
 * When the jurisdiction has a custom `forwardSubjectTemplate` / `forwardBodyTemplate` on file (the two
 * new columns), THAT template is interpolated against the report's values and rendered through the same
 * HTML layout (card + footer + dark mode). Subject and body are independent: whichever is custom uses the
 * template, the other keeps the refined default.
 */
export function buildReportPacket(
  record: AdminReportRecord,
  routing: AdminReportRoutingRecord | null,
  mediaLinks: string[],
  note: string | null,
  forwardSubjectTemplate?: string | null,
  forwardBodyTemplate?: string | null,
): ReportPacket {
  const ref = record.referenceCode ?? record.id.slice(0, 8)
  const categoryLabel = REPORT_CATEGORY_LABELS[record.category]
  const place = routing?.place ?? record.place
  const address = record.address && record.address.trim() !== "" ? record.address : place
  const reporter = record.reporter?.name ?? "anonymous"
  const noteText = note && note.trim() !== "" ? note.trim() : null
  const desc = record.desc && record.desc.trim() !== "" ? record.desc.trim() : "(none provided)"
  const submittedDate = formatSubmittedDate(record.createdAt)

  const hasCustomBody =
    typeof forwardBodyTemplate === "string" && forwardBodyTemplate.trim() !== ""
  const hasCustomSubject =
    typeof forwardSubjectTemplate === "string" && forwardSubjectTemplate.trim() !== ""

  // Subject: interpolated custom (then sanitized for a header) or the refined default.
  const subject = hasCustomSubject
    ? sanitizeHeaderValue(
        interpolateForwardTemplate(
          forwardSubjectTemplate,
          buildTemplateValues(record, routing, mediaLinks, noteText),
        ),
      )
    : sanitizeHeaderValue(`[civfix] ${record.title} - ${place} - ${ref}`)

  let blocks: EmailBlock[]
  if (hasCustomBody) {
    // Interpolate the custom body, then split on blank lines into paragraph blocks so it keeps the civfix
    // card/footer/dark-mode chrome. paragraph() HTML-escapes its text (email-blocks htmlText), so template
    // content can never inject markup.
    const rendered = interpolateForwardTemplate(
      forwardBodyTemplate,
      buildTemplateValues(record, routing, mediaLinks, noteText),
    ).replace(/\r\n?/g, "\n")
    blocks = rendered
      .split(/\n[ \t]*\n/)
      .map((p) => p.trim())
      .filter((p) => p !== "")
      .map((p) => paragraph(p))
    if (blocks.length === 0) blocks = [paragraph(rendered.trim())]
  } else {
    // Refined default: concise, scannable, complete.
    blocks = [
      paragraph(
        `A resident reported a ${categoryLabel} issue in ${place} through civfix on ${submittedDate}. ` +
          `Reply to this email to respond directly to the resident and civfix.`,
      ),
      kvTable([
        ["Reference", ref],
        ["Category", categoryLabel],
        ["Location", address],
        ["Coordinates", `${record.lat}, ${record.lng}`],
        ["Reported by", reporter],
        ["Confirmed by", `${record.confirmations} neighbors`],
        ["Submitted", submittedDate],
      ]),
      button(mapLinkFor(record.lat, record.lng), "View exact location on map"),
      heading("What was reported"),
      paragraph(desc),
    ]
    if (noteText !== null) {
      blocks.push(heading("Note from the civfix team"), quote(noteText))
    }
    if (mediaLinks.length > 0) {
      blocks.push(
        linkList(
          `Photos (${mediaLinks.length})`,
          mediaLinks.map((href, i) => ({ label: `Photo ${i + 1}`, href })),
        ),
      )
    }
    blocks.push(
      paragraph(`civfix reference ${ref} - reply to this email to reach the resident.`, {
        muted: true,
      }),
    )
  }

  const { text, html } = renderEmailBody({
    preheader: `A resident reported a ${categoryLabel} issue in ${place}.`,
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
