import { tokens } from "@civfix/shared"
import {
  markdownInlineToPlainText,
  type MarkdownInline,
  type MarkdownList,
} from "@civfix/shared/markdown"
import { escapeHtml } from "./mail-text.js"

export interface EmailBlock {
  html: string
  text: string
}

const INK = tokens.color.neutral.ink
const INK2 = tokens.color.neutral.ink2
const INK3 = tokens.color.neutral.ink3
const BORDER = tokens.color.neutral.ink5
const BRAND = tokens.color.brand.bloom
const LINK = tokens.color.sky["600"]
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"

function htmlText(value: string): string {
  return escapeHtml(value).replace(/\n/g, "<br>")
}


export function heading(text: string): EmailBlock {
  return {
    html: `<h2 class="cv-ink" style="margin:18px 0 8px;font-family:${FONT};font-size:15px;line-height:1.3;font-weight:700;color:${INK};">${escapeHtml(text)}</h2>`,
    text,
  }
}

export function paragraph(text: string, opts: { muted?: boolean } = {}): EmailBlock {
  const color = opts.muted ? INK3 : INK2
  const size = opts.muted ? "13px" : "15px"
  const inkClass = opts.muted ? "cv-ink3" : "cv-ink2"
  return {
    html: `<p class="${inkClass}" style="margin:0 0 14px;font-family:${FONT};font-size:${size};line-height:1.55;color:${color};">${htmlText(text)}</p>`,
    text,
  }
}

export function kvTable(rows: Array<[string, string]>): EmailBlock {
  const cells = rows
    .map(([label, value], i) => {
      const ruled = i < rows.length - 1
      const rule = ruled ? `1px solid ${BORDER}` : "none"
      const ruleClass = ruled ? " cv-rule" : ""
      return (
        `<tr><td class="cv-ink3${ruleClass}" style="padding:7px 12px 7px 0;font-family:${FONT};font-size:13px;color:${INK3};font-weight:600;white-space:nowrap;vertical-align:top;border-bottom:${rule};">${escapeHtml(label)}</td>` +
        `<td class="cv-ink${ruleClass}" style="padding:7px 0;font-family:${FONT};font-size:14px;color:${INK};vertical-align:top;border-bottom:${rule};">${htmlText(value)}</td></tr>`
      )
    })
    .join("")
  const pad = Math.max(...rows.map(([label]) => label.length)) + 2
  const text = rows.map(([label, value]) => `${(label + ":").padEnd(pad)}${value}`).join("\n")
  return {
    html: `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 14px;border-collapse:collapse;">${cells}</table>`,
    text,
  }
}

export function quote(text: string): EmailBlock {
  return {
    html: `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 14px;"><tr><td class="cv-panel cv-ink2" style="padding:10px 14px;background:${tokens.color.neutral.paper2};border-left:3px solid ${BORDER};font-family:${FONT};font-size:14px;line-height:1.55;color:${INK2};">${htmlText(text)}</td></tr></table>`,
    text: text
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n"),
  }
}

export function button(href: string, label: string): EmailBlock {
  return {
    html:
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 16px;"><tr>` +
      `<td bgcolor="${BRAND}" style="border-radius:8px;">` +
      `<a href="${escapeHtml(href)}" style="display:inline-block;padding:10px 20px;font-family:${FONT};font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">${escapeHtml(label)}</a>` +
      `</td></tr></table>`,
    text: `${label}: ${href}`,
  }
}

export function code(value: string): EmailBlock {
  return {
    html: `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 16px;"><tr><td class="cv-panel cv-ink" style="padding:14px 24px;background:${tokens.color.neutral.paper2};border-radius:10px;font-family:${FONT};font-size:30px;font-weight:700;letter-spacing:6px;color:${INK};">${escapeHtml(value)}</td></tr></table>`,
    text: value,
  }
}

export function linkList(label: string, items: Array<{ label: string; href: string }>): EmailBlock {
  const lis = items
    .map(
      (it) =>
        `<li class="cv-ink2" style="margin:0 0 4px;font-family:${FONT};font-size:14px;"><a class="cv-link" href="${escapeHtml(it.href)}" style="color:${LINK};">${escapeHtml(it.label)}</a></li>`,
    )
    .join("")
  return {
    html: `<p class="cv-ink3" style="margin:0 0 6px;font-family:${FONT};font-size:13px;color:${INK3};font-weight:600;">${escapeHtml(label)}</p><ul style="margin:0 0 14px;padding-left:20px;">${lis}</ul>`,
    text: `${label}:\n${items.map((it) => `  ${it.label}: ${it.href}`).join("\n")}`,
  }
}

function inlineHtml(spans: readonly MarkdownInline[]): string {
  return spans
    .map((span) => {
      switch (span.type) {
        case "text":
          return htmlText(span.value)
        case "strong":
          return `<strong>${inlineHtml(span.children)}</strong>`
        case "em":
          return `<em>${inlineHtml(span.children)}</em>`
        case "link":
          return `<a class="cv-link" href="${escapeHtml(span.href)}" style="color:${LINK};">${inlineHtml(span.children)}</a>`
      }
    })
    .join("")
}

export function richParagraph(spans: readonly MarkdownInline[]): EmailBlock {
  return {
    html: `<p class="cv-ink2" style="margin:0 0 14px;font-family:${FONT};font-size:15px;line-height:1.55;color:${INK2};">${inlineHtml(spans)}</p>`,
    text: markdownInlineToPlainText(spans),
  }
}

export function richList(list: MarkdownList): EmailBlock {
  const tag = list.ordered ? "ol" : "ul"
  const items = list.items
    .map(
      (item) =>
        `<li class="cv-ink2" style="margin:0 0 4px;font-family:${FONT};font-size:15px;line-height:1.55;color:${INK2};">${inlineHtml(item.children)}</li>`,
    )
    .join("")
  const text = list.items
    .map((item, i) => `${list.ordered ? `${i + 1}.` : "-"} ${markdownInlineToPlainText(item.children)}`)
    .join("\n")
  return {
    html: `<${tag} style="margin:0 0 14px;padding-left:20px;">${items}</${tag}>`,
    text,
  }
}
