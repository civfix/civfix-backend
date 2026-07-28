/**
 * The service-hours transcript renderer (P5): a pure `TranscriptModel` in, PDF bytes out. No DB, no
 * storage, no clock — the issue timestamp is an input, so re-rendering a stored snapshot reproduces the
 * same document.
 *
 * ⚠ THIS IS THE ONLY FILE ALLOWED TO IMPORT `pdfkit` OR `qrcode-generator`, AND IT MUST IMPORT THEM
 * LAZILY, INSIDE THE RENDER PATH (C19) — exactly the convention `adapters/storage.r2.ts` follows for
 * `@aws-sdk/*`. This module sits on the boot import chain
 * (routes/index.ts -> service-hours-certificates.routes.ts -> certificate-service.ts -> here), so a
 * top-level import that fails to resolve or trips CJS/ESM interop in the pruned `pnpm deploy --prod` tree
 * would throw at import time: `dist/main.js` never boots, the api container never turns healthy, and the
 * deploy gate fails AFTER compose has already recreated the container. Dynamic imports degrade that to a
 * 500 on one endpoint.
 *
 * ⚠ NO HAND-SIGNATURE GRAPHIC AND NO SIGNATURE LINE. No human signs this document; drawing a signature
 * would be a fabricated attestation. The seal plus the platform issuer identity is the honest equivalent,
 * and is what platform-issued credentials actually do. The attestation paragraph is true of the shipped
 * rules in `volunteer-hours-service.ts` (organizer/cohost gate, actor-must-be-verified, self-credit
 * block, the automatic report award) — do not soften or embellish it.
 */

import { formatCertificateCode } from "@civfix/shared"
import { FONT, fontBuffer, fontFor } from "./certificate-fonts.js"
import {
  DEFAULT_PAGE_PLAN_OPTIONS,
  issuerNeedsNewPage,
  planPages,
  totalsFitsOnPage,
} from "./certificate-layout.js"
import {
  CERTIFICATE_TIME_ZONE,
  certificateTranslator,
  communitiesLabel,
  type CertificateTranslator,
  type TranscriptModel,
} from "./certificate-model.js"

/** Where a verifier is sent. The QR carries this base + the display form of the code. */
export const CERTIFICATE_VERIFY_BASE_URL = "https://civfix.org/service-record"

export interface ServiceHoursPdfInput {
  model: TranscriptModel
  /** Canonical 12-char code. Printed and QR'd in its `CFX-XXXX-XXXX-XXXX` display form. */
  code: string
  issuedAt: Date | string
  /**
   * Printed as "Document fingerprint". This is the LEDGER fingerprint, not `document_sha256`: a document
   * cannot contain the hash of its own bytes, and the stored sha is computed from what this function
   * returns. Omitted from the page when absent.
   */
  fingerprint?: string | null
  verifyBaseUrl?: string
  /** Injected in tests; the default is the server message catalog for `model.locale`. */
  t?: CertificateTranslator
}

// ---- Page geometry (DP §3.1) --------------------------------------------------------------------

/**
 * US Letter is 612 x 792pt; the content column is x 54..558. The content FLOOR (y 730) lives in
 * certificate-layout.ts, because it is what the pure planner paginates against — it is deliberately not
 * restated here.
 */
const PAGE = {
  left: 54,
  right: 558,
  contentWidth: 504,
  footerRule: 738,
  footerText: 746,
  footnote: 758,
} as const

/**
 * Print palette derived from the design tokens. The page itself stays WHITE, not `neutral.paper`: a
 * full-bleed sand background wastes ink and prints as muddy grey on a laser printer.
 *
 * RULE: coral TEXT is always `#C74537`; `#F0685C` is decorative fill only (it is ~2.6:1 on card fill and
 * fails contrast even in print). This mirrors the `accentText` discipline in @civfix/ui.
 */
const COLOR = {
  card: "#FFFDF8",
  tile: "#F8F1E4",
  band: "#E5DDCD",
  ink: "#211B13",
  ink2: "#5C5546",
  ink3: "#8D8577",
  rule: "#BDB5A6",
  hairline: "#ECE5D8",
  accent: "#F0685C",
  verified: "#2F7D46",
} as const

/** The five table columns, x + width summing to exactly the 504pt content width. */
const COL = {
  date: { x: 54, w: 62 },
  activity: { x: 116, w: 194 },
  community: { x: 310, w: 104 },
  hours: { x: 414, w: 46 },
  creditedBy: { x: 460, w: 98 },
} as const

const ROW_MIN_HEIGHT = 20
const ROW_PADDING = 8

/** A pdfkit document, typed through @types/pdfkit without importing the runtime module at load time. */
type Doc = PDFKit.PDFDocument

/**
 * Register a face on FIRST USE and select it. The ~4.6 MB Korean face is parsed by pdfkit per document,
 * so a Latin-only transcript must never touch it.
 */
function useFont(doc: Doc, registered: Set<string>, file: string, size: number): Doc {
  if (!registered.has(file)) {
    doc.registerFont(file, fontBuffer(file))
    registered.add(file)
  }
  return doc.font(file).fontSize(size)
}

/** Display-weight face for one string: the brand display face, or Noto when the string needs CJK. */
function displayFont(text: string): string {
  return fontFor(text, "bold") === FONT.cjk ? FONT.cjk : FONT.display
}

function toDate(value: Date | string): Date {
  return typeof value === "string" ? new Date(value) : value
}

export async function buildServiceHoursPdf(input: ServiceHoursPdfInput): Promise<Uint8Array> {
  // C19: lazy, inside the render path. Never move these to the top of the file.
  const PDFDocument = (await import("pdfkit")).default
  const qrcode = (await import("qrcode-generator")).default

  const { model } = input
  const t = input.t ?? certificateTranslator(model.locale)
  const locale = model.locale
  const displayCode = formatCertificateCode(input.code)
  const issuedAt = toDate(input.issuedAt)
  const verifyUrl = `${input.verifyBaseUrl ?? CERTIFICATE_VERIFY_BASE_URL}/${displayCode}`
  const holderName = model.holder.displayName
  const issuedLabel = formatDate(issuedAt, locale)

  const doc = new PDFDocument({
    size: "LETTER",
    margins: { top: 48, bottom: 54, left: 54, right: 54 },
    // Both are load-bearing: bufferPages for the "Page N of M" second pass, autoFirstPage:false so the
    // pageAdded handler is attached BEFORE page 1 exists and page 1 needs no special case.
    bufferPages: true,
    autoFirstPage: false,
    pdfVersion: "1.7",
    lang: locale,
    displayTitle: true,
    info: {
      Title: t("certificate.doc.pdf_title", { name: holderName, code: displayCode }),
      Author: "civfix",
      Subject: t("certificate.doc.title"),
      Keywords: displayCode,
      Creator: "civfix",
      Producer: "civfix",
      // Pinned to the issue time (not "now") so a re-render of the same snapshot is byte-identical.
      CreationDate: issuedAt,
      ModDate: issuedAt,
    },
  })

  const chunks: Buffer[] = []
  doc.on("data", (chunk: Buffer) => chunks.push(chunk))
  const finished = new Promise<void>((resolve, reject) => {
    doc.on("end", () => resolve())
    doc.on("error", (err: Error) => reject(err))
  })

  const registered = new Set<string>()
  const font = (file: string, size: number) => useFont(doc, registered, file, size)

  /**
   * Write ONE line and clip it.
   *
   * ⚠ pdfkit wraps as soon as a `width` is given — `lineBreak: false` does NOT stop it. An unclipped
   * label is not a cosmetic problem: a longer translation of "Credited by" would wrap out of the column
   * band and land on top of the first table row. `height` + `ellipsis` is the combination that clips, and
   * the height has to come from the CURRENT font (Baloo's line box is far taller than Hanken's at the
   * same size), which is why this runs after `font(...)`.
   */
  function line(
    file: string,
    size: number,
    color: string,
    text: string,
    x: number,
    y: number,
    extra: PDFKit.Mixins.TextOptions = {},
  ): void {
    font(file, size).fillColor(color)
    doc.text(text, x, y, {
      lineBreak: false,
      ellipsis: true,
      height: doc.currentLineHeight() + 0.5,
      ...extra,
    })
  }

  let pageNumber = 0
  /**
   * Whether the NEXT page continues the table. A continuation page that carries only the totals row or
   * the issuer block must not repeat the column band: a DATE / ACTIVITY / HOURS header with no table
   * under it reads, on an official document, as if rows were lost.
   */
  let tableContinues = true
  doc.on("pageAdded", () => {
    pageNumber += 1
    if (pageNumber === 1) drawFirstPageChrome()
    else drawContinuationChrome()
  })

  // ---- page chrome ------------------------------------------------------------------------------

  function drawFirstPageChrome(): void {
    doc.rect(PAGE.left, 36, PAGE.contentWidth, 5).fill(COLOR.accent)

    line(FONT.wordmark, 26, COLOR.ink, "civfix", PAGE.left, 54)
    line(FONT.display, 8, COLOR.ink3, t("certificate.doc.title").toUpperCase(), PAGE.left, 86, {
      width: 260,
      characterSpacing: 0.9,
    })

    line(FONT.display, 7, COLOR.ink3, t("certificate.header.number").toUpperCase(), 330, 56, {
      width: 228,
      align: "right",
      characterSpacing: 0.6,
    })
    line(FONT.mono, 12, COLOR.ink, displayCode, 330, 68, { width: 228, align: "right" })

    hairline(112)
    drawHolderCard()
    drawSummaryTiles()
    drawColumnBand(322)
  }

  function drawContinuationChrome(): void {
    line(FONT.wordmark, 11, COLOR.ink, "civfix", PAGE.left, 40)
    const trail = `${t("certificate.doc.title")} · ${holderName} · ${displayCode}`
    line(fontFor(trail, "regular"), 8, COLOR.ink3, trail, 150, 42, { width: 408, align: "right" })
    hairline(70)
    if (tableContinues) drawColumnBand(78)
  }

  function hairline(y: number): void {
    doc
      .moveTo(PAGE.left, y)
      .lineTo(PAGE.right, y)
      .lineWidth(0.75)
      .strokeColor(COLOR.hairline)
      .stroke()
  }

  function drawHolderCard(): void {
    const top = 126
    doc
      .roundedRect(PAGE.left, top, PAGE.contentWidth, 88, 10)
      .lineWidth(0.75)
      .fillAndStroke(COLOR.card, COLOR.hairline)

    const x = PAGE.left + 16
    line(FONT.display, 8, COLOR.ink3, t("certificate.holder.eyebrow").toUpperCase(), x, top + 14, {
      width: 290,
      characterSpacing: 0.8,
    })
    line(displayFont(holderName), 20, COLOR.ink, holderName, x, top + 28, { width: 290 })

    let y = top + 56
    if (model.holder.handle) {
      line(
        fontFor(model.holder.handle, "regular"),
        10,
        COLOR.ink2,
        `@${model.holder.handle}`,
        x,
        y,
        {
          width: 290,
        },
      )
      y += 14
    }
    if (model.holder.verified) {
      // The check is DRAWN, not typed: the Latin brand faces have no U+2713 glyph, so a literal check
      // mark prints as a .notdef box — right next to the word "verified", of all places.
      drawCheck(x, y + 2)
      const verified = t("certificate.holder.verified")
      line(fontFor(verified, "bold"), 9, COLOR.verified, verified, x + 12, y, { width: 278 })
    }

    // Right column: period of service + issue date, right-aligned inside the card.
    const rx = 366
    const rw = 176
    const period =
      model.periodStart && model.periodEnd
        ? `${formatDate(new Date(model.periodStart), locale)} – ${formatDate(new Date(model.periodEnd), locale)}`
        : "—"
    labelledValue(rx, top + 14, rw, t("certificate.holder.period"), period)
    labelledValue(rx, top + 48, rw, t("certificate.holder.issued"), issuedLabel)
  }

  /** A 9pt moss check mark, drawn as two strokes so no font has to own the glyph. */
  function drawCheck(x: number, y: number): void {
    doc
      .moveTo(x, y + 4)
      .lineTo(x + 2.6, y + 6.8)
      .lineTo(x + 8, y + 0.8)
      .lineWidth(1.4)
      .strokeColor(COLOR.verified)
      .stroke()
  }

  function labelledValue(x: number, y: number, w: number, label: string, value: string): void {
    line(FONT.display, 7, COLOR.ink3, label.toUpperCase(), x, y, {
      width: w,
      align: "right",
      characterSpacing: 0.6,
    })
    line(fontFor(value, "regular"), 9.5, COLOR.ink, value, x, y + 11, { width: w, align: "right" })
  }

  function drawSummaryTiles(): void {
    const top = 228
    const w = 160
    const gap = 12
    const communities = model.jurisdictions
    const tiles: { label: string; value: string; note?: string }[] = [
      {
        label: t("certificate.summary.total_hours"),
        value: formatNumber(model.totalHours, locale),
      },
      {
        label: t("certificate.summary.activities"),
        value: formatNumber(model.entryCount, locale),
      },
      {
        label: t("certificate.summary.communities"),
        value: formatNumber(communities.length, locale),
        note: communitiesLabel(communities, t),
      },
    ]

    tiles.forEach((tile, index) => {
      const x = PAGE.left + index * (w + gap)
      doc.roundedRect(x, top, w, 78, 10).fill(COLOR.tile)
      if (index === 0) doc.rect(x, top + 10, 3, 58).fill(COLOR.accent)
      line(FONT.display, 7.5, COLOR.ink3, tile.label.toUpperCase(), x + 14, top + 14, {
        width: w - 24,
        characterSpacing: 0.7,
      })
      line(FONT.display, 30, COLOR.ink, tile.value, x + 14, top + 28, { width: w - 24 })
      if (tile.note) {
        line(fontFor(tile.note, "regular"), 8, COLOR.ink3, tile.note, x + 14, top + 62, {
          width: w - 24,
        })
      }
    })
  }

  function drawColumnBand(y: number): void {
    doc.rect(PAGE.left, y, PAGE.contentWidth, 22).fill(COLOR.band)
    const labels: [{ x: number; w: number }, string, "left" | "right"][] = [
      [COL.date, t("certificate.table.date"), "left"],
      [COL.activity, t("certificate.table.activity"), "left"],
      [COL.community, t("certificate.table.community"), "left"],
      [COL.hours, t("certificate.table.hours"), "right"],
      [COL.creditedBy, t("certificate.table.credited_by"), "left"],
    ]
    for (const [col, label, align] of labels) {
      line(
        FONT.display,
        7.5,
        COLOR.ink2,
        label.toUpperCase(),
        col.x + (align === "left" ? 6 : 0),
        y + 7,
        { width: col.w - 6, align, characterSpacing: 0.6 },
      )
    }
    doc
      .moveTo(PAGE.left, y + 22)
      .lineTo(PAGE.right, y + 22)
      .lineWidth(0.75)
      .strokeColor(COLOR.rule)
      .stroke()
  }

  // ---- table ------------------------------------------------------------------------------------

  // Measure every Activity cell first: the page plan is computed from REAL heights, which is what keeps
  // certificate-layout.ts pure and independently testable.
  const rowHeights = model.rows.map((row) => {
    font(fontFor(row.activity, "regular"), 9.5)
    const twoLines = doc.currentLineHeight() * 2
    const measured = Math.min(
      doc.heightOfString(row.activity, { width: COL.activity.w - 12 }),
      twoLines,
    )
    return Math.max(ROW_MIN_HEIGHT, measured + ROW_PADDING)
  })
  const pages = planPages(rowHeights)

  doc.addPage()

  let cursorY = 0
  for (const plan of pages) {
    if (plan.page > 1) doc.addPage()
    let y = plan.top
    for (let i = plan.startIndex; i < plan.endIndex; i++) {
      const row = model.rows[i]
      const height = rowHeights[i] ?? ROW_MIN_HEIGHT
      if (!row) continue
      if (i % 2 === 0) doc.rect(PAGE.left, y, PAGE.contentWidth, height).fill(COLOR.card)
      drawRow(row, y, height)
      y += height
    }
    cursorY = y
  }

  function drawRow(row: TranscriptModel["rows"][number], y: number, height: number): void {
    const textY = y + 6
    line(fontFor(row.dateLabel, "regular"), 9, COLOR.ink2, row.dateLabel, COL.date.x + 6, textY, {
      width: COL.date.w - 8,
    })
    // The Activity cell is the ONE multi-line cell: up to two lines, then ellipsis.
    font(fontFor(row.activity, "regular"), 9.5).fillColor(COLOR.ink)
    doc.text(row.activity, COL.activity.x + 6, textY, {
      width: COL.activity.w - 12,
      height: height - 6,
      ellipsis: true,
    })
    line(
      fontFor(row.community, "regular"),
      9,
      COLOR.ink2,
      row.community,
      COL.community.x + 6,
      textY,
      {
        width: COL.community.w - 12,
      },
    )
    line(FONT.mono, 9.5, COLOR.ink, row.hours.toFixed(2), COL.hours.x, textY, {
      width: COL.hours.w - 4,
      align: "right",
    })
    line(
      fontFor(row.creditedBy, "regular"),
      9,
      COLOR.ink2,
      row.creditedBy,
      COL.creditedBy.x + 6,
      textY,
      { width: COL.creditedBy.w - 8 },
    )
  }

  // ---- totals + truncation banner ---------------------------------------------------------------

  if (!totalsFitsOnPage(cursorY)) {
    tableContinues = false
    doc.addPage()
    cursorY = DEFAULT_PAGE_PLAN_OPTIONS.continuationTop
  }
  doc
    .moveTo(PAGE.left, cursorY + 4)
    .lineTo(PAGE.right, cursorY + 4)
    .lineWidth(1)
    .strokeColor(COLOR.rule)
    .stroke()
  line(
    FONT.bodyBold,
    9.5,
    COLOR.ink,
    t("certificate.table.total").toUpperCase(),
    COL.activity.x + 6,
    cursorY + 10,
    { width: 240, characterSpacing: 0.5 },
  )
  // 2dp like every row above it, so the column reads as a column and the total is visibly their sum.
  line(FONT.mono, 10, COLOR.ink, model.totalHours.toFixed(2), COL.hours.x, cursorY + 10, {
    width: COL.hours.w - 4,
    align: "right",
  })
  doc
    .moveTo(PAGE.left, cursorY + 26)
    .lineTo(PAGE.right, cursorY + 26)
    .lineWidth(1)
    .strokeColor(COLOR.rule)
    .stroke()
  cursorY += 30

  if (model.truncated) {
    const banner = t("certificate.table.truncated", {
      shown: formatNumber(model.includedCount, locale),
      total: formatNumber(model.entryCount, locale),
    })
    font(fontFor(banner, "regular"), 8.5)
      .fillColor(COLOR.ink3)
      .text(banner, PAGE.left, cursorY, { width: PAGE.contentWidth, height: 22 })
    cursorY += 22
  }

  // ---- issuer / attestation block ---------------------------------------------------------------

  if (issuerNeedsNewPage(cursorY)) {
    tableContinues = false
    doc.addPage()
    cursorY = DEFAULT_PAGE_PLAN_OPTIONS.continuationTop
  } else {
    cursorY += 24
  }
  drawIssuerBlock(cursorY)

  function drawIssuerBlock(top: number): void {
    const attestation = t("certificate.attestation.body")
    font(fontFor(attestation, "regular"), 9.5).fillColor(COLOR.ink2)
    const paragraphHeight = doc.heightOfString(attestation, { width: 460 })
    doc.text(attestation, PAGE.left, top, { width: 460 })

    const blockTop = top + paragraphHeight + 22

    // Seal: 68pt circle, coral stroke + inner ring. NO signature graphic and NO signature line.
    const sealX = PAGE.left
    const cx = sealX + 34
    const cy = blockTop + 34
    doc.circle(cx, cy, 34).lineWidth(1.5).strokeColor(COLOR.accent).stroke()
    doc.circle(cx, cy, 29).lineWidth(1).strokeColor(COLOR.accent).stroke()
    // Seal text is clipped hard: it sits INSIDE a 68pt circle, and a wrapped word would leave the ring.
    line(FONT.display, 9, COLOR.ink, "CIVFIX", sealX, cy - 16, {
      width: 68,
      align: "center",
      characterSpacing: 1.2,
    })
    line(FONT.display, 6, COLOR.ink2, t("certificate.seal.line").toUpperCase(), sealX, cy - 2, {
      width: 64,
      align: "center",
      characterSpacing: 0.2,
    })
    line(FONT.mono, 8, COLOR.ink3, String(issuedAt.getUTCFullYear()), sealX, cy + 8, {
      width: 68,
      align: "center",
    })

    const issuerLine = t("certificate.issuer.line")
    line(fontFor(issuerLine, "bold"), 9, COLOR.ink, issuerLine, sealX, blockTop + 78, {
      width: 260,
    })
    line(
      FONT.mono,
      7.5,
      COLOR.ink3,
      // Whole seconds: the millisecond field is noise on a printed page.
      t("certificate.issuer.generated", {
        timestamp: issuedAt.toISOString().replace(/\.\d{3}Z$/, "Z"),
      }),
      sealX,
      blockTop + 90,
      { width: 260 },
    )

    // Right: the QR + the code a verifier can type instead of scanning.
    drawQr(verifyUrl, 474, blockTop, 84)
    const textX = 306
    const textW = 156
    const prompt = t("certificate.verify.prompt")
    font(fontFor(prompt, "regular"), 8).fillColor(COLOR.ink2)
    doc.text(prompt, textX, blockTop + 4, {
      width: textW,
      align: "right",
      height: 24,
      ellipsis: true,
    })
    line(FONT.mono, 11, COLOR.ink, displayCode, textX, blockTop + 34, {
      width: textW,
      align: "right",
    })
    if (input.fingerprint) {
      // Label and digest on separate lines: 16 hex characters plus a label do not fit one 156pt line at
      // any readable size, and an ellipsized fingerprint is worse than none.
      const fingerprintLabel = t("certificate.verify.fingerprint")
      line(
        fontFor(fingerprintLabel, "regular"),
        7,
        COLOR.ink3,
        fingerprintLabel,
        textX,
        blockTop + 50,
        {
          width: textW,
          align: "right",
        },
      )
      line(FONT.mono, 7.5, COLOR.ink3, input.fingerprint.slice(0, 16), textX, blockTop + 59, {
        width: textW,
        align: "right",
      })
    }
  }

  function drawQr(url: string, x: number, y: number, box: number): void {
    const qr = qrcode(0, "M")
    qr.addData(url)
    qr.make()
    const count = qr.getModuleCount()
    // Keep a 4-module quiet zone INSIDE the reserved box, then centre what is left.
    const cell = box / (count + 8)
    const originX = x + cell * 4
    const originY = y + cell * 4
    doc.fillColor(COLOR.ink)
    for (let row = 0; row < count; row++) {
      for (let col = 0; col < count; col++) {
        if (qr.isDark(row, col)) {
          doc.rect(originX + col * cell, originY + row * cell, cell, cell).fill(COLOR.ink)
        }
      }
    }
  }

  // ---- footers (the buffered second pass) -------------------------------------------------------

  const range = doc.bufferedPageRange()
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i)
    // WITHOUT this, writing below the bottom margin makes pdfkit ADD A BLANK PAGE — forever.
    const savedBottom = doc.page.margins.bottom
    doc.page.margins.bottom = 0
    drawFooter(i - range.start + 1, range.count)
    doc.page.margins.bottom = savedBottom
  }

  function drawFooter(page: number, total: number): void {
    doc
      .moveTo(PAGE.left, PAGE.footerRule)
      .lineTo(PAGE.right, PAGE.footerRule)
      .lineWidth(0.75)
      .strokeColor(COLOR.hairline)
      .stroke()
    line(
      FONT.body,
      7.5,
      COLOR.ink3,
      `${displayCode} · ${issuedLabel}`,
      PAGE.left,
      PAGE.footerText,
      {
        width: 200,
      },
    )
    line(FONT.body, 7.5, COLOR.ink3, "civfix.org/service-record", 206, PAGE.footerText, {
      width: 200,
      align: "center",
    })
    line(
      FONT.body,
      7.5,
      COLOR.ink3,
      t("certificate.footer.page", { page, total }),
      358,
      PAGE.footerText,
      { width: 200, align: "right" },
    )
    if (page === 1) {
      const footnote = t("certificate.footer.timezone")
      line(fontFor(footnote, "regular"), 7, COLOR.ink3, footnote, PAGE.left, PAGE.footnote, {
        width: PAGE.contentWidth,
      })
    }
  }

  doc.end()
  await finished
  return new Uint8Array(Buffer.concat(chunks))
}

/** Same zone + style as the model's row dates, so every date on the page agrees. */
function formatDate(value: Date, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeZone: CERTIFICATE_TIME_ZONE,
  }).format(value)
}

function formatNumber(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: Number.isInteger(value) ? 0 : 1,
    maximumFractionDigits: 2,
  }).format(value)
}
