import { tokens } from "@civfix/shared"
import { escapeHtml } from "./mail-text.js"
import type { EmailBlock } from "./email-blocks.js"
import { WORDMARK_FONT_WOFF2_BASE64 } from "./email-wordmark-font.js"

const INK3 = tokens.color.neutral.ink3
const BORDER = tokens.color.neutral.ink5
const CARD = tokens.color.neutral.card
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"

const DARK_SURFACE = "#23201C"
const DARK_PANEL = "#2E2A24"
const DARK_BORDER = "#3A352E"
const DARK_INK = "#F4EFE4"
const DARK_INK2 = "#DCD5C6"
const DARK_INK3 = "#A8A093"
const DARK_LINK = "#8FBBE4"

const WORDMARK: Array<[letter: string, color: string]> = [
  ["c", "#ff7a6b"],
  ["i", "#e5ae1c"],
  ["v", "#6fb36f"],
  ["f", "#6fb1dc"],
  ["i", "#9c82de"],
  ["x", "#ff7a6b"],
]

const WORDMARK_FONT_FAMILY = "civfix-wordmark"

const WORDMARK_FONT_CSS =
  `@media screen{@font-face{font-family:'${WORDMARK_FONT_FAMILY}';font-style:normal;font-weight:800;` +
  `src:url(data:font/woff2;base64,${WORDMARK_FONT_WOFF2_BASE64}) format('woff2');}` +
  `.cv-wordmark{font-family:'${WORDMARK_FONT_FAMILY}',${FONT}!important;}}`

const WORDMARK_HTML = WORDMARK.map(
  ([letter, color]) => `<span style="color:${color};">${letter}</span>`,
).join("")

const DEFAULT_FOOTER =
  "civfix is a civic reporting platform that connects residents with their local government.\n" +
  "This mailbox is not monitored. civfix.org"

export const CITY_FOOTER =
  "You're receiving this because a resident routed civic activity to your office through civfix, " +
  "a civic reporting platform. Reply to this email to respond. civfix.org"

export interface EventFooterOptions {
  eventTitle: string
  unsubscribeUrl?: string
  replyTo?: string | null
  critical?: boolean
  manageUrl?: string
}

export interface FooterSegment {
  text: string
  href?: string
}

// A footer built from segments so that only the URLs the code supplies become links. Host-authored text
// (an event title, a reply address) sits in civfix-branded footer copy, where an auto-linked URL would
// read as a link civfix vouches for.
export interface EmailFooter {
  segments: readonly FooterSegment[]
}

const LINE_BREAK: FooterSegment = { text: "\n" }

function linkLine(label: string, url: string): FooterSegment[] {
  return [{ text: label }, { text: url, href: url }]
}

export function eventFooter(opts: EventFooterOptions): EmailFooter {
  const lines: FooterSegment[][] = []
  if (opts.critical === true) {
    lines.push([
      {
        text:
          `This is a service message about "${opts.eventTitle}", an event you signed up for on civfix. ` +
          `You receive these even if you have turned off updates from this organizer.`,
      },
    ])
  } else {
    lines.push([
      {
        text:
          `You're receiving this because you signed up for "${opts.eventTitle}" on civfix. ` +
          `The organizer wrote this message; civfix delivered it and never gave them your email address.`,
      },
    ])
  }
  if (opts.replyTo !== undefined && opts.replyTo !== null && opts.replyTo.length > 0) {
    lines.push([{ text: `Replies go to the organizer at ${opts.replyTo}.` }])
  } else {
    lines.push([{ text: "Replies to this address are not monitored." }])
  }
  if (opts.critical !== true && opts.unsubscribeUrl !== undefined) {
    lines.push(linkLine("Stop receiving messages about this event: ", opts.unsubscribeUrl))
  }
  if (opts.manageUrl !== undefined) {
    lines.push(linkLine("Manage your signup: ", opts.manageUrl))
  }
  lines.push([{ text: "civfix.org" }])
  return { segments: lines.flatMap((line, i) => (i === 0 ? line : [LINE_BREAK, ...line])) }
}

function footerSegments(footer: string | EmailFooter): readonly FooterSegment[] {
  return typeof footer === "string" ? [{ text: footer }] : footer.segments
}

function footerText(footer: string | EmailFooter): string {
  return footerSegments(footer)
    .map((segment) => segment.text)
    .join("")
}

function footerHtml(footer: string | EmailFooter): string {
  return footerSegments(footer)
    .map((segment) => {
      const text = escapeHtml(segment.text)
      if (segment.href === undefined) return text.replace(/\n/g, "<br>")
      return `<a class="cv-link" href="${escapeHtml(segment.href)}" style="color:inherit;">${text}</a>`
    })
    .join("")
}

export interface RenderEmailOptions {
  preheader?: string
  footer?: string | EmailFooter
  blocks: EmailBlock[]
}

export function renderEmailBody(opts: RenderEmailOptions): { text: string; html: string } {
  const footer = opts.footer ?? DEFAULT_FOOTER
  const blocksHtml = opts.blocks.map((b) => b.html).join("")
  const preheader =
    opts.preheader !== undefined && opts.preheader.length > 0
      ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;opacity:0;">${escapeHtml(opts.preheader)}</div>`
      : ""
  const html =
    `<!DOCTYPE html><html lang="en"><head>` +
    `<meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="color-scheme" content="light dark">` +
    `<meta name="supported-color-schemes" content="light dark">` +
    `<style>${WORDMARK_FONT_CSS}</style>` +
    `<style>@media (max-width:600px){.cv-container{width:100%!important;}.cv-pad{padding-left:20px!important;padding-right:20px!important;}}` +
    `@media (prefers-color-scheme:dark){` +
    `.cv-body{background:${DARK_SURFACE}!important;}` +
    `.cv-card{background:${DARK_SURFACE}!important;border-color:${DARK_BORDER}!important;}` +
    `.cv-ink{color:${DARK_INK}!important;}` +
    `.cv-ink2{color:${DARK_INK2}!important;}` +
    `.cv-ink3{color:${DARK_INK3}!important;}` +
    `.cv-link{color:${DARK_LINK}!important;}` +
    `.cv-rule{border-color:${DARK_BORDER}!important;}` +
    `.cv-panel{background:${DARK_PANEL}!important;border-color:${DARK_BORDER}!important;}` +
    `}</style>` +
    `</head>` +
    `<body class="cv-body" style="margin:0;padding:0;background:${CARD};">` +
    preheader +
    `<table role="presentation" class="cv-body" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${CARD};">` +
    `<tr><td align="center" style="padding:24px 12px;">` +
    `<table role="presentation" class="cv-container cv-card" cellpadding="0" cellspacing="0" border="0" width="600" style="width:600px;max-width:600px;background:${CARD};border:1px solid ${BORDER};border-radius:14px;overflow:hidden;">` +
    `<tr><td class="cv-pad cv-rule" style="padding:22px 28px 16px;border-bottom:1px solid ${BORDER};"><span class="cv-wordmark" style="font-family:${FONT};font-size:24px;font-weight:800;letter-spacing:0.01em;">${WORDMARK_HTML}</span></td></tr>` +
    `<tr><td class="cv-pad" style="padding:26px 28px;">${blocksHtml}</td></tr>` +
    `<tr><td class="cv-pad cv-rule" style="padding:18px 28px 24px;border-top:1px solid ${BORDER};"><p class="cv-ink3" style="margin:0;font-family:${FONT};font-size:12px;line-height:1.5;color:${INK3};">${footerHtml(footer)}</p></td></tr>` +
    `</table></td></tr></table></body></html>`

  const text = [...opts.blocks.map((b) => b.text), "--", footerText(footer)].join("\n\n")
  return { text, html }
}
