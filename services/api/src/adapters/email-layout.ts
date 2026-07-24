import { tokens } from "@civfix/shared"
import { escapeHtml } from "./mail-text.js"
import type { EmailBlock } from "./email-blocks.js"

const INK3 = tokens.color.neutral.ink3
const BORDER = tokens.color.neutral.ink5
const PAPER = tokens.color.neutral.paper
const CARD = tokens.color.neutral.card
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"

/**
 * Per-letter colors of the "civfix" rainbow wordmark, mirroring .cf-logo on civfix.org
 * (c coral, i gold, v green, f sky, i violet, x coral). The masthead renders the wordmark as
 * colored text on the card background — email clients can't load the brand webfont, so a heavy
 * system-font weight stands in for the logo's rounded face.
 */
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
  "civfix — civic reporting that connects residents with their local government. " +
  "Reply to this email to respond. civfix.org"

export const CITY_FOOTER =
  "You're receiving this because a resident routed civic activity to your office through civfix, " +
  "a civic reporting platform. Reply to this email to respond. civfix.org"

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
    `@media (prefers-color-scheme:dark){.cv-body{background:#1A1714!important;}.cv-card{background:#23201C!important;}}</style>` +
    `</head>` +
    `<body class="cv-body" style="margin:0;padding:0;background:${PAPER};">` +
    preheader +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${PAPER};">` +
    `<tr><td align="center" style="padding:24px 12px;">` +
    `<table role="presentation" class="cv-container cv-card" cellpadding="0" cellspacing="0" border="0" width="600" style="width:600px;max-width:600px;background:${CARD};border:1px solid ${BORDER};border-radius:14px;overflow:hidden;">` +
    `<tr><td class="cv-pad" style="padding:22px 28px 16px;border-bottom:1px solid ${BORDER};"><span style="font-family:${FONT};font-size:24px;font-weight:800;letter-spacing:0.01em;">${WORDMARK_HTML}</span></td></tr>` +
    `<tr><td class="cv-pad" style="padding:26px 28px;">${blocksHtml}</td></tr>` +
    `<tr><td class="cv-pad" style="padding:18px 28px 24px;border-top:1px solid ${BORDER};"><p style="margin:0;font-family:${FONT};font-size:12px;line-height:1.5;color:${INK3};">${escapeHtml(footerText)}</p></td></tr>` +
    `</table></td></tr></table></body></html>`

  const text = [...opts.blocks.map((b) => b.text), "—", footerText].join("\n\n")
  return { text, html }
}
