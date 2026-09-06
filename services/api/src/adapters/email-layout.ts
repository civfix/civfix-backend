import { tokens } from "@civfix/shared"
import { escapeHtml } from "./mail-text.js"
import type { EmailBlock } from "./email-blocks.js"

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

const WORDMARK_HTML = WORDMARK.map(
  ([letter, color]) => `<span style="color:${color};">${letter}</span>`,
).join("")

const DEFAULT_FOOTER =
  "civfix is a civic reporting platform that connects residents with their local government. " +
  "Reply to this email to respond. civfix.org"

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

export function eventFooter(opts: EventFooterOptions): string {
  const lines: string[] = []
  if (opts.critical === true) {
    lines.push(
      `This is a service message about "${opts.eventTitle}", an event you signed up for on civfix. ` +
        `You receive these even if you have turned off updates from this organizer.`,
    )
  } else {
    lines.push(
      `You're receiving this because you signed up for "${opts.eventTitle}" on civfix. ` +
        `The organizer wrote this message; civfix delivered it and never gave them your email address.`,
    )
  }
  if (opts.replyTo !== undefined && opts.replyTo !== null && opts.replyTo.length > 0) {
    lines.push(`Replies go to the organizer at ${opts.replyTo}.`)
  } else {
    lines.push("Replies to this address are not monitored.")
  }
  if (opts.critical !== true && opts.unsubscribeUrl !== undefined) {
    lines.push(`Stop receiving messages about this event: ${opts.unsubscribeUrl}`)
  }
  if (opts.manageUrl !== undefined) {
    lines.push(`Manage your signup: ${opts.manageUrl}`)
  }
  lines.push("civfix.org")
  return lines.join(" ")
}

export interface RenderEmailOptions {
  preheader?: string
  footer?: string
  blocks: EmailBlock[]
}

export function renderEmailBody(opts: RenderEmailOptions): { text: string; html: string } {
  const footerText = opts.footer ?? DEFAULT_FOOTER
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
    `<tr><td class="cv-pad cv-rule" style="padding:22px 28px 16px;border-bottom:1px solid ${BORDER};"><span style="font-family:${FONT};font-size:24px;font-weight:800;letter-spacing:0.01em;">${WORDMARK_HTML}</span></td></tr>` +
    `<tr><td class="cv-pad" style="padding:26px 28px;">${blocksHtml}</td></tr>` +
    `<tr><td class="cv-pad cv-rule" style="padding:18px 28px 24px;border-top:1px solid ${BORDER};"><p class="cv-ink3" style="margin:0;font-family:${FONT};font-size:12px;line-height:1.5;color:${INK3};">${escapeHtml(footerText)}</p></td></tr>` +
    `</table></td></tr></table></body></html>`

  const text = [...opts.blocks.map((b) => b.text), "--", footerText].join("\n\n")
  return { text, html }
}
