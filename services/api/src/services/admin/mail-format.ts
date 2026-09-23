import { sanitizeHeaderValue } from "../../adapters/mail-text.js"
import {
  button,
  heading,
  kvTable,
  linkList,
  paragraph,
  quote,
  richParagraph,
  type EmailBlock,
} from "../../adapters/email-blocks.js"
import { CITY_FOOTER, renderEmailBody } from "../../adapters/email-layout.js"
import {
  ADMIN_REPORT_STATUS_LABELS,
  DEFAULT_FORWARD_BODY_TEMPLATE,
  DEFAULT_FORWARD_SUBJECT_TEMPLATE,
  REPORT_CATEGORY_LABELS,
  forwardTemplateIssues,
  interpolateForwardTemplate,
  templateUsesToken,
} from "@civfix/shared"
import type {
  AdminReportMediaRecord,
  AdminReportRecord,
  AdminReportRoutingRecord,
} from "./admin-report-types.js"
import type { MarkdownInline } from "@civfix/shared/markdown"

export const NO_PHOTO_LINKS = "(none)"

export const MAX_PACKET_ATTACHMENTS = 10
export const MAX_PACKET_ATTACHMENT_BYTES = 10 * 1024 * 1024
export const MAX_PACKET_TOTAL_BYTES = 8 * 1024 * 1024

const ATTACHMENT_EXTENSIONS: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
}

const EXTENSION_FALLBACK = ".jpg"

function hasExtension(name: string): boolean {
  return /\.[A-Za-z0-9]{2,5}$/.test(name)
}

export function attachmentFilename(r2Key: string, index: number, contentType?: string): string {
  const ext = ATTACHMENT_EXTENSIONS[(contentType ?? "").trim().toLowerCase()] ?? EXTENSION_FALLBACK
  const tail = r2Key.split("/").pop() ?? ""
  const cleaned = tail.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "")
  if (cleaned.length === 0) return `photo-${index + 1}${ext}`
  if (hasExtension(cleaned)) return cleaned.slice(0, 120)
  return `${cleaned.slice(0, 120 - ext.length)}${ext}`
}

export interface ReportPacket {
  subject: string
  text: string
  html: string
}

export interface PacketMediaLink {
  kind: AdminReportMediaRecord["kind"]
  url: string
}

interface LabelledMediaLink {
  label: string
  href: string
}

const MEDIA_KIND_LABELS: Record<PacketMediaLink["kind"], string> = {
  image: "Photo",
  video: "Video",
}

function labelPacketMedia(media: readonly PacketMediaLink[]): LabelledMediaLink[] {
  const counts: Record<PacketMediaLink["kind"], number> = { image: 0, video: 0 }
  return media.map(({ kind, url }) => {
    counts[kind] += 1
    return { label: `${MEDIA_KIND_LABELS[kind]} ${counts[kind]}`, href: url }
  })
}

function photoLinksValue(labelled: readonly LabelledMediaLink[]): string {
  if (labelled.length === 0) return NO_PHOTO_LINKS
  return labelled.map(({ label, href }) => `- ${label}: ${href}`).join("\n")
}

function mediaListHeading(media: readonly PacketMediaLink[]): string {
  const noun = media.some(({ kind }) => kind === "video") ? "Photos and videos" : "Photos"
  return `${noun} (${media.length})`
}

function mapLinkFor(lat: number, lng: number): string {
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=18/${lat}/${lng}`
}

function formatSubmittedDate(d: Date): string {
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })
}

function buildTemplateValues(
  record: AdminReportRecord,
  routing: AdminReportRoutingRecord | null,
  labelledMedia: readonly LabelledMediaLink[],
  noteText: string | null,
): Record<string, string> {
  const ref = record.referenceCode ?? record.id.slice(0, 8)
  const categoryLabel = REPORT_CATEGORY_LABELS[record.category]
  const place = routing?.place ?? record.place
  const address = record.address && record.address.trim() !== "" ? record.address : place
  const desc = record.desc && record.desc.trim() !== "" ? record.desc.trim() : "(none provided)"
  return {
    referenceCode: ref,
    reportId: record.id,
    shortId: record.id.slice(0, 8),
    title: record.title,
    category: categoryLabel,
    status: ADMIN_REPORT_STATUS_LABELS[record.status],
    place,
    address,
    coordinates: `${record.lat}, ${record.lng}`,
    lat: String(record.lat),
    lng: String(record.lng),
    mapLink: mapLinkFor(record.lat, record.lng),
    description: desc,
    confirmations: String(record.confirmations),
    submittedDate: formatSubmittedDate(record.createdAt),
    jurisdictionName: routing?.place ?? place,
    operatorNote: noteText ?? "",
    photoLinks: photoLinksValue(labelledMedia),
    photoCount: String(labelledMedia.length),
  }
}

export interface ForwardTemplates {
  subject: string | null
  body: string | null
}

function resolveTemplate(template: string | null, fallback: string): string {
  return template !== null && template.trim() !== "" ? template : fallback
}

function stripUnresolvedTokens(rendered: string): string {
  const issues = forwardTemplateIssues(rendered)
  if (issues.length === 0) return rendered
  let out = rendered
  for (const issue of [...issues].sort((a, b) => b.index - a.index)) {
    out = out.slice(0, issue.index) + out.slice(issue.index + issue.token.length)
  }
  return out
}

const URL_RE = /https?:\/\/[^\s<>"']+/g

function linkedParagraph(text: string): EmailBlock {
  const spans: MarkdownInline[] = []
  let last = 0
  for (const match of text.matchAll(URL_RE)) {
    const start = match.index ?? 0
    const href = match[0].replace(/[.,;:!?)]+$/, "")
    if (start > last) spans.push({ type: "text", value: text.slice(last, start) })
    spans.push({ type: "link", href, children: [{ type: "text", value: href }] })
    last = start + href.length
  }
  if (spans.length === 0) return paragraph(text)
  if (last < text.length) spans.push({ type: "text", value: text.slice(last) })
  return { html: richParagraph(spans).html, text }
}

function templateParagraphs(rendered: string): EmailBlock[] {
  const blocks = rendered
    .split(/\n[ \t]*\n/)
    .map((p) => p.trim())
    .filter((p) => p !== "")
    .map(linkedParagraph)
  return blocks.length > 0 ? blocks : [paragraph(rendered.trim())]
}

export function buildReportPacket(
  record: AdminReportRecord,
  routing: AdminReportRoutingRecord | null,
  media: readonly PacketMediaLink[],
  note: string | null,
  templates: ForwardTemplates,
): ReportPacket {
  const categoryLabel = REPORT_CATEGORY_LABELS[record.category]
  const place = routing?.place ?? record.place
  const noteText = note && note.trim() !== "" ? note.trim() : null
  const labelledMedia = labelPacketMedia(media)
  const values = buildTemplateValues(record, routing, labelledMedia, noteText)

  const subjectTemplate = resolveTemplate(templates.subject, DEFAULT_FORWARD_SUBJECT_TEMPLATE)
  const bodyTemplate = resolveTemplate(templates.body, DEFAULT_FORWARD_BODY_TEMPLATE)

  const subject = sanitizeHeaderValue(
    interpolateForwardTemplate(stripUnresolvedTokens(subjectTemplate), values),
  )
  const blocks = templateParagraphs(
    interpolateForwardTemplate(stripUnresolvedTokens(bodyTemplate), values).replace(/\r\n?/g, "\n"),
  )

  if (noteText !== null && !templateUsesToken(bodyTemplate, "operatorNote")) {
    blocks.push(quote(noteText))
  }
  if (labelledMedia.length > 0 && !templateUsesToken(bodyTemplate, "photoLinks")) {
    blocks.push(linkList(mediaListHeading(media), labelledMedia))
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
  displayName?: string | null
}

export const DISCUSSION_FORWARD_ANONYMOUS_AUTHOR = "A neighbor"

export function discussionForwardAuthor(displayName: string | null | undefined): string {
  const trimmed = (displayName ?? "").trim()
  return trimmed === "" ? DISCUSSION_FORWARD_ANONYMOUS_AUTHOR : trimmed
}

export function buildDiscussionForwardPacket(
  input: DiscussionForwardInput,
  comment: string,
): ReportPacket {
  const id8 = input.reportId.slice(0, 8)
  const place = input.place ?? input.org ?? "the area"
  const subject = `civfix report: ${sanitizeHeaderValue(`${input.category} in ${place}`)} [${id8}]`
  const body = comment.trim() !== "" ? comment.trim() : "(no comment provided)"
  const author = discussionForwardAuthor(input.displayName)
  const lede = `${author} commented on a ${input.category} report in ${place} via civfix and mentioned your office.`

  const { text, html } = renderEmailBody({
    preheader: lede,
    footer: CITY_FOOTER,
    blocks: [
      paragraph(lede),
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
  const subject =
    ref !== null ? `civfix event: ${safeTitle} [${ref}]` : `civfix event: ${safeTitle}`
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
