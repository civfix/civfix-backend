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
  EMPTY_VALUE,
  type CertificateTranslator,
  type TranscriptModel,
} from "./certificate-model.js"

export const CERTIFICATE_VERIFY_PATH = "/service-record"

const CERTIFICATE_VERIFY_BASE_URL = `https://civfix.org${CERTIFICATE_VERIFY_PATH}`

export interface ServiceHoursPdfInput {
  model: TranscriptModel
  code: string
  issuedAt: Date | string
  fingerprint?: string | null
  verifyBaseUrl?: string
  t?: CertificateTranslator
}

const BRAND = "civfix"
const SEAL_WORDMARK = "CIVFIX"
const DOC_MARGINS = { top: 48, bottom: 54, left: 54, right: 54 } as const
const PDF_VERSION = "1.7"

const URL_SCHEME = /^https?:\/\//
const ISO_MILLISECONDS = /\.\d{3}Z$/
const FINGERPRINT_PRINTED_CHARS = 16

const QR_TYPE_NUMBER_AUTO = 0
const QR_ERROR_CORRECTION = "M"
/** ISO/IEC 18004 asks for a four-module light margin around the symbol. */
const QR_QUIET_ZONE_MODULES = 4

const PAGE = {
  left: 54,
  right: 558,
  contentWidth: 504,
  footerRule: 738,
  footerText: 746,
  footnote: 758,
} as const

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
} as const

const COL = {
  date: { x: 54, w: 62 },
  activity: { x: 116, w: 194 },
  community: { x: 310, w: 104 },
  hours: { x: 414, w: 46 },
  creditedBy: { x: 460, w: 98 },
} as const

const HAIRLINE_WIDTH = 0.75
const RULE_WIDTH = 1
const CARD_RADIUS = 10

const ACCENT_BAR = { y: 36, height: 5 } as const
const LETTERHEAD_RULE_Y = 112
const RUNNING_HEADER_RULE_Y = 70
const HOLDER_CARD = {
  top: 126,
  height: 88,
  inset: 16,
  width: 290,
  asideX: 366,
  asideWidth: 176,
} as const
const SUMMARY_TILE = { top: 228, width: 160, gap: 12, height: 78 } as const
const COLUMN_BAND = { firstPageY: 322, continuationY: 78, height: 22 } as const
const CELL_INSET = 6

const ROW_MIN_HEIGHT = 20
const ROW_PADDING = 8
const ACTIVITY_MAX_LINES = 2

const TOTALS_ROW = { ruleAbove: 4, textOffset: 10, ruleBelow: 26, advance: 30 } as const
const TRUNCATION_BANNER_HEIGHT = 22
const ISSUER_GAP = 24
const ATTESTATION_WIDTH = 460
const SEAL = { radius: 34, innerRadius: 29 } as const
const QR_BOX = { x: 474, size: 84 } as const
const VERIFY_TEXT = { x: 306, width: 156 } as const
const FOOTER_COLUMN_WIDTH = 200

type Doc = PDFKit.PDFDocument
type QrCodeFactory = typeof import("qrcode-generator")
type TranscriptRow = TranscriptModel["rows"][number]
interface Column {
  x: number
  w: number
}

interface PdfContext {
  doc: Doc
  registeredFonts: Set<string>
  qrcode: QrCodeFactory
  t: CertificateTranslator
  locale: string
  model: TranscriptModel
  holderName: string
  displayCode: string
  issuedAt: Date
  issuedLabel: string
  verifyUrl: string
  verifyLabel: string
  fingerprint: string | null | undefined
  /** Read by the page-added hook: once the table has ended, a new page gets no column band. */
  tableContinues: boolean
}

function useFont(ctx: PdfContext, file: string, size: number): Doc {
  if (!ctx.registeredFonts.has(file)) {
    ctx.doc.registerFont(file, fontBuffer(file))
    ctx.registeredFonts.add(file)
  }
  return ctx.doc.font(file).fontSize(size)
}

function displayFont(text: string): string {
  return fontFor(text, "bold") === FONT.cjk ? FONT.cjk : FONT.display
}

function toDate(value: Date | string): Date {
  return typeof value === "string" ? new Date(value) : value
}

function line(
  ctx: PdfContext,
  file: string,
  size: number,
  color: string,
  text: string,
  x: number,
  y: number,
  extra: PDFKit.Mixins.TextOptions = {},
): void {
  useFont(ctx, file, size).fillColor(color)
  ctx.doc.text(text, x, y, {
    lineBreak: false,
    ellipsis: true,
    height: ctx.doc.currentLineHeight() + 0.5,
    ...extra,
  })
}

function horizontalRule(ctx: PdfContext, y: number, width: number, color: string): void {
  ctx.doc.moveTo(PAGE.left, y).lineTo(PAGE.right, y).lineWidth(width).strokeColor(color).stroke()
}

function hairline(ctx: PdfContext, y: number): void {
  horizontalRule(ctx, y, HAIRLINE_WIDTH, COLOR.hairline)
}

function drawFirstPageChrome(ctx: PdfContext): void {
  const { doc, t } = ctx
  doc.rect(PAGE.left, ACCENT_BAR.y, PAGE.contentWidth, ACCENT_BAR.height).fill(COLOR.accent)

  line(ctx, FONT.wordmark, 26, COLOR.ink, BRAND, PAGE.left, 54)
  line(ctx, FONT.display, 8, COLOR.ink3, t("certificate.doc.title").toUpperCase(), PAGE.left, 86, {
    width: 260,
    characterSpacing: 0.9,
  })

  line(ctx, FONT.display, 7, COLOR.ink3, t("certificate.header.number").toUpperCase(), 330, 56, {
    width: 228,
    align: "right",
    characterSpacing: 0.6,
  })
  line(ctx, FONT.mono, 12, COLOR.ink, ctx.displayCode, 330, 68, { width: 228, align: "right" })

  hairline(ctx, LETTERHEAD_RULE_Y)
  drawHolderCard(ctx)
  drawSummaryTiles(ctx)
  drawColumnBand(ctx, COLUMN_BAND.firstPageY)
}

function drawContinuationChrome(ctx: PdfContext): void {
  line(ctx, FONT.wordmark, 11, COLOR.ink, BRAND, PAGE.left, 40)
  const trail = `${ctx.t("certificate.doc.title")} · ${ctx.holderName} · ${ctx.displayCode}`
  line(ctx, fontFor(trail, "regular"), 8, COLOR.ink3, trail, 150, 42, {
    width: 408,
    align: "right",
  })
  hairline(ctx, RUNNING_HEADER_RULE_Y)
  if (ctx.tableContinues) drawColumnBand(ctx, COLUMN_BAND.continuationY)
}

function holderPeriodLabel(ctx: PdfContext): string {
  const { periodStart, periodEnd } = ctx.model
  if (!periodStart || !periodEnd) return EMPTY_VALUE
  return `${formatDate(new Date(periodStart), ctx.locale)} – ${formatDate(new Date(periodEnd), ctx.locale)}`
}

function drawHolderCard(ctx: PdfContext): void {
  const { doc, t, model, holderName } = ctx
  const { top, width } = HOLDER_CARD
  doc
    .roundedRect(PAGE.left, top, PAGE.contentWidth, HOLDER_CARD.height, CARD_RADIUS)
    .lineWidth(HAIRLINE_WIDTH)
    .fillAndStroke(COLOR.card, COLOR.hairline)

  const x = PAGE.left + HOLDER_CARD.inset
  line(
    ctx,
    FONT.display,
    8,
    COLOR.ink3,
    t("certificate.holder.eyebrow").toUpperCase(),
    x,
    top + 14,
    {
      width,
      characterSpacing: 0.8,
    },
  )
  line(ctx, displayFont(holderName), 20, COLOR.ink, holderName, x, top + 28, { width })

  const handle = model.holder.handle
  if (handle) {
    line(ctx, fontFor(handle, "regular"), 10, COLOR.ink2, `@${handle}`, x, top + 56, { width })
  }
  const { asideX, asideWidth } = HOLDER_CARD
  labelledValue(
    ctx,
    asideX,
    top + 14,
    asideWidth,
    t("certificate.holder.period"),
    holderPeriodLabel(ctx),
  )
  labelledValue(ctx, asideX, top + 48, asideWidth, t("certificate.holder.issued"), ctx.issuedLabel)
}

function labelledValue(
  ctx: PdfContext,
  x: number,
  y: number,
  w: number,
  label: string,
  value: string,
): void {
  line(ctx, FONT.display, 7, COLOR.ink3, label.toUpperCase(), x, y, {
    width: w,
    align: "right",
    characterSpacing: 0.6,
  })
  line(ctx, fontFor(value, "regular"), 9.5, COLOR.ink, value, x, y + 11, {
    width: w,
    align: "right",
  })
}

interface SummaryTile {
  label: string
  value: string
  note?: string
}

function summaryTiles(ctx: PdfContext): SummaryTile[] {
  const { t, model, locale } = ctx
  const communities = model.jurisdictions
  return [
    { label: t("certificate.summary.total_hours"), value: formatNumber(model.totalHours, locale) },
    { label: t("certificate.summary.activities"), value: formatNumber(model.entryCount, locale) },
    {
      label: t("certificate.summary.communities"),
      value: formatNumber(communities.length, locale),
      note: communitiesLabel(communities, t),
    },
  ]
}

function drawSummaryTiles(ctx: PdfContext): void {
  const { doc } = ctx
  const { top, width: w, gap } = SUMMARY_TILE
  summaryTiles(ctx).forEach((tile, index) => {
    const x = PAGE.left + index * (w + gap)
    doc.roundedRect(x, top, w, SUMMARY_TILE.height, CARD_RADIUS).fill(COLOR.tile)
    if (index === 0) doc.rect(x, top + 10, 3, 58).fill(COLOR.accent)
    line(ctx, FONT.display, 7.5, COLOR.ink3, tile.label.toUpperCase(), x + 14, top + 14, {
      width: w - 24,
      characterSpacing: 0.7,
    })
    line(ctx, FONT.display, 30, COLOR.ink, tile.value, x + 14, top + 28, { width: w - 24 })
    if (tile.note) {
      line(ctx, fontFor(tile.note, "regular"), 8, COLOR.ink3, tile.note, x + 14, top + 62, {
        width: w - 24,
      })
    }
  })
}

function drawColumnBand(ctx: PdfContext, y: number): void {
  const { doc, t } = ctx
  doc.rect(PAGE.left, y, PAGE.contentWidth, COLUMN_BAND.height).fill(COLOR.band)
  const labels: [Column, string, "left" | "right"][] = [
    [COL.date, t("certificate.table.date"), "left"],
    [COL.activity, t("certificate.table.activity"), "left"],
    [COL.community, t("certificate.table.community"), "left"],
    [COL.hours, t("certificate.table.hours"), "right"],
    [COL.creditedBy, t("certificate.table.credited_by"), "left"],
  ]
  for (const [col, label, align] of labels) {
    line(
      ctx,
      FONT.display,
      7.5,
      COLOR.ink2,
      label.toUpperCase(),
      col.x + (align === "left" ? CELL_INSET : 0),
      y + 7,
      { width: col.w - CELL_INSET, align, characterSpacing: 0.6 },
    )
  }
  horizontalRule(ctx, y + COLUMN_BAND.height, HAIRLINE_WIDTH, COLOR.rule)
}

function measureRowHeights(ctx: PdfContext): number[] {
  return ctx.model.rows.map((row) => {
    useFont(ctx, fontFor(row.activity, "regular"), 9.5)
    const maxActivityHeight = ctx.doc.currentLineHeight() * ACTIVITY_MAX_LINES
    const measured = Math.min(
      ctx.doc.heightOfString(row.activity, { width: COL.activity.w - 2 * CELL_INSET }),
      maxActivityHeight,
    )
    return Math.max(ROW_MIN_HEIGHT, measured + ROW_PADDING)
  })
}

function drawRow(ctx: PdfContext, row: TranscriptRow, y: number, height: number): void {
  const textY = y + CELL_INSET
  line(
    ctx,
    fontFor(row.dateLabel, "regular"),
    9,
    COLOR.ink2,
    row.dateLabel,
    COL.date.x + CELL_INSET,
    textY,
    {
      width: COL.date.w - 8,
    },
  )
  useFont(ctx, fontFor(row.activity, "regular"), 9.5).fillColor(COLOR.ink)
  ctx.doc.text(row.activity, COL.activity.x + CELL_INSET, textY, {
    width: COL.activity.w - 2 * CELL_INSET,
    height: height - CELL_INSET,
    ellipsis: true,
  })
  line(
    ctx,
    fontFor(row.community, "regular"),
    9,
    COLOR.ink2,
    row.community,
    COL.community.x + CELL_INSET,
    textY,
    { width: COL.community.w - 2 * CELL_INSET },
  )
  line(ctx, FONT.mono, 9.5, COLOR.ink, row.hours.toFixed(2), COL.hours.x, textY, {
    width: COL.hours.w - 4,
    align: "right",
  })
  line(
    ctx,
    fontFor(row.creditedBy, "regular"),
    9,
    COLOR.ink2,
    row.creditedBy,
    COL.creditedBy.x + CELL_INSET,
    textY,
    { width: COL.creditedBy.w - 8 },
  )
}

function drawLedgerTable(ctx: PdfContext, rowHeights: readonly number[]): number {
  let cursorY = 0
  for (const plan of planPages(rowHeights)) {
    if (plan.page > 1) ctx.doc.addPage()
    let y = plan.top
    for (let i = plan.startIndex; i < plan.endIndex; i++) {
      const row = ctx.model.rows[i]
      const height = rowHeights[i] ?? ROW_MIN_HEIGHT
      if (!row) continue
      if (i % 2 === 0) ctx.doc.rect(PAGE.left, y, PAGE.contentWidth, height).fill(COLOR.card)
      drawRow(ctx, row, y, height)
      y += height
    }
    cursorY = y
  }
  return cursorY
}

function startTrailingPage(ctx: PdfContext): number {
  ctx.tableContinues = false
  ctx.doc.addPage()
  return DEFAULT_PAGE_PLAN_OPTIONS.continuationTop
}

function drawTotals(ctx: PdfContext, tableEndY: number): number {
  const cursorY = totalsFitsOnPage(tableEndY) ? tableEndY : startTrailingPage(ctx)
  horizontalRule(ctx, cursorY + TOTALS_ROW.ruleAbove, RULE_WIDTH, COLOR.rule)
  line(
    ctx,
    FONT.bodyBold,
    9.5,
    COLOR.ink,
    ctx.t("certificate.table.total").toUpperCase(),
    COL.activity.x + CELL_INSET,
    cursorY + TOTALS_ROW.textOffset,
    { width: 240, characterSpacing: 0.5 },
  )
  line(
    ctx,
    FONT.mono,
    10,
    COLOR.ink,
    ctx.model.totalHours.toFixed(2),
    COL.hours.x,
    cursorY + TOTALS_ROW.textOffset,
    { width: COL.hours.w - 4, align: "right" },
  )
  horizontalRule(ctx, cursorY + TOTALS_ROW.ruleBelow, RULE_WIDTH, COLOR.rule)
  return cursorY + TOTALS_ROW.advance
}

function drawTruncationBanner(ctx: PdfContext, cursorY: number): number {
  const { model, locale } = ctx
  if (!model.truncated) return cursorY
  const banner = ctx.t("certificate.table.truncated", {
    shown: formatNumber(model.includedCount, locale),
    total: formatNumber(model.entryCount, locale),
  })
  useFont(ctx, fontFor(banner, "regular"), 8.5)
    .fillColor(COLOR.ink3)
    .text(banner, PAGE.left, cursorY, {
      width: PAGE.contentWidth,
      height: TRUNCATION_BANNER_HEIGHT,
    })
  return cursorY + TRUNCATION_BANNER_HEIGHT
}

function issuerBlockTop(ctx: PdfContext, cursorY: number): number {
  return issuerNeedsNewPage(cursorY) ? startTrailingPage(ctx) : cursorY + ISSUER_GAP
}

function drawSeal(ctx: PdfContext, x: number, top: number): void {
  const { doc } = ctx
  const cx = x + SEAL.radius
  const cy = top + SEAL.radius
  doc.circle(cx, cy, SEAL.radius).lineWidth(1.5).strokeColor(COLOR.accent).stroke()
  doc.circle(cx, cy, SEAL.innerRadius).lineWidth(1).strokeColor(COLOR.accent).stroke()
  line(ctx, FONT.display, 9, COLOR.ink, SEAL_WORDMARK, x, cy - 16, {
    width: 68,
    align: "center",
    characterSpacing: 1.2,
  })
  line(ctx, FONT.display, 6, COLOR.ink2, ctx.t("certificate.seal.line").toUpperCase(), x, cy - 2, {
    width: 64,
    align: "center",
    characterSpacing: 0.2,
  })
  line(ctx, FONT.mono, 8, COLOR.ink3, formatYear(ctx.issuedAt), x, cy + 8, {
    width: 68,
    align: "center",
  })
}

function drawIssuerLines(ctx: PdfContext, x: number, blockTop: number): void {
  const issuerLine = ctx.t("certificate.issuer.line")
  line(ctx, fontFor(issuerLine, "bold"), 9, COLOR.ink, issuerLine, x, blockTop + 78, {
    width: 260,
  })
  line(
    ctx,
    FONT.mono,
    7.5,
    COLOR.ink3,
    ctx.t("certificate.issuer.generated", {
      timestamp: ctx.issuedAt.toISOString().replace(ISO_MILLISECONDS, "Z"),
    }),
    x,
    blockTop + 90,
    { width: 260 },
  )
}

function drawVerifyText(ctx: PdfContext, blockTop: number): void {
  const { x, width } = VERIFY_TEXT
  const prompt = ctx.t("certificate.verify.prompt", { url: ctx.verifyLabel })
  useFont(ctx, fontFor(prompt, "regular"), 8).fillColor(COLOR.ink2)
  ctx.doc.text(prompt, x, blockTop + 4, { width, align: "right", height: 24, ellipsis: true })
  line(ctx, FONT.mono, 11, COLOR.ink, ctx.displayCode, x, blockTop + 34, { width, align: "right" })
  if (!ctx.fingerprint) return
  const fingerprintLabel = ctx.t("certificate.verify.fingerprint")
  line(
    ctx,
    fontFor(fingerprintLabel, "regular"),
    7,
    COLOR.ink3,
    fingerprintLabel,
    x,
    blockTop + 50,
    {
      width,
      align: "right",
    },
  )
  line(
    ctx,
    FONT.mono,
    7.5,
    COLOR.ink3,
    ctx.fingerprint.slice(0, FINGERPRINT_PRINTED_CHARS),
    x,
    blockTop + 59,
    { width, align: "right" },
  )
}

function drawIssuerBlock(ctx: PdfContext, top: number): void {
  const { doc } = ctx
  const attestation = ctx.t("certificate.attestation.body")
  useFont(ctx, fontFor(attestation, "regular"), 9.5).fillColor(COLOR.ink2)
  const paragraphHeight = doc.heightOfString(attestation, { width: ATTESTATION_WIDTH })
  doc.text(attestation, PAGE.left, top, { width: ATTESTATION_WIDTH })

  const blockTop = top + paragraphHeight + 22
  drawSeal(ctx, PAGE.left, blockTop)
  drawIssuerLines(ctx, PAGE.left, blockTop)
  drawQr(ctx, ctx.verifyUrl, QR_BOX.x, blockTop, QR_BOX.size)
  drawVerifyText(ctx, blockTop)
}

function drawQr(ctx: PdfContext, url: string, x: number, y: number, box: number): void {
  const { doc } = ctx
  const qr = ctx.qrcode(QR_TYPE_NUMBER_AUTO, QR_ERROR_CORRECTION)
  qr.addData(url)
  qr.make()
  const count = qr.getModuleCount()
  const cell = box / (count + 2 * QR_QUIET_ZONE_MODULES)
  const originX = x + cell * QR_QUIET_ZONE_MODULES
  const originY = y + cell * QR_QUIET_ZONE_MODULES
  doc.fillColor(COLOR.ink)
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) {
        doc.rect(originX + col * cell, originY + row * cell, cell, cell).fill(COLOR.ink)
      }
    }
  }
}

function drawFooter(ctx: PdfContext, page: number, total: number): void {
  hairline(ctx, PAGE.footerRule)
  line(
    ctx,
    FONT.body,
    7.5,
    COLOR.ink3,
    `${ctx.displayCode} · ${ctx.issuedLabel}`,
    PAGE.left,
    PAGE.footerText,
    { width: FOOTER_COLUMN_WIDTH },
  )
  line(ctx, FONT.body, 7.5, COLOR.ink3, ctx.verifyLabel, 206, PAGE.footerText, {
    width: FOOTER_COLUMN_WIDTH,
    align: "center",
  })
  line(
    ctx,
    FONT.body,
    7.5,
    COLOR.ink3,
    ctx.t("certificate.footer.page", { page, total }),
    358,
    PAGE.footerText,
    { width: FOOTER_COLUMN_WIDTH, align: "right" },
  )
  if (page === 1) {
    const footnote = ctx.t("certificate.footer.timezone")
    line(ctx, fontFor(footnote, "regular"), 7, COLOR.ink3, footnote, PAGE.left, PAGE.footnote, {
      width: PAGE.contentWidth,
    })
  }
}

/** The footer sits below the bottom margin, so the margin is lifted while it is drawn. */
function drawFooters(ctx: PdfContext): void {
  const { doc } = ctx
  const range = doc.bufferedPageRange()
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i)
    const savedBottom = doc.page.margins.bottom
    doc.page.margins.bottom = 0
    drawFooter(ctx, i - range.start + 1, range.count)
    doc.page.margins.bottom = savedBottom
  }
}

function collectBytes(doc: Doc): Promise<Uint8Array> {
  const chunks: Buffer[] = []
  doc.on("data", (chunk: Buffer) => chunks.push(chunk))
  return new Promise<Uint8Array>((resolve, reject) => {
    doc.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))))
    doc.on("error", (err: Error) => reject(err))
  })
}

export async function buildServiceHoursPdf(input: ServiceHoursPdfInput): Promise<Uint8Array> {
  const PDFDocument = (await import("pdfkit")).default
  const qrcode = (await import("qrcode-generator")).default

  const { model } = input
  const t = input.t ?? certificateTranslator(model.locale)
  const locale = model.locale
  const displayCode = formatCertificateCode(input.code)
  const issuedAt = toDate(input.issuedAt)
  const verifyBaseUrl = input.verifyBaseUrl ?? CERTIFICATE_VERIFY_BASE_URL
  const holderName = model.holder.displayName

  const doc = new PDFDocument({
    size: "LETTER",
    margins: DOC_MARGINS,
    bufferPages: true,
    autoFirstPage: false,
    pdfVersion: PDF_VERSION,
    lang: locale,
    displayTitle: true,
    info: {
      Title: t("certificate.doc.pdf_title", { name: holderName, code: displayCode }),
      Author: BRAND,
      Subject: t("certificate.doc.title"),
      Keywords: displayCode,
      Creator: BRAND,
      Producer: BRAND,
      CreationDate: issuedAt,
      ModDate: issuedAt,
    },
  })
  const bytes = collectBytes(doc)

  const ctx: PdfContext = {
    doc,
    registeredFonts: new Set<string>(),
    qrcode,
    t,
    locale,
    model,
    holderName,
    displayCode,
    issuedAt,
    issuedLabel: formatDate(issuedAt, locale),
    verifyUrl: `${verifyBaseUrl}/${displayCode}`,
    verifyLabel: verifyBaseUrl.replace(URL_SCHEME, ""),
    fingerprint: input.fingerprint,
    tableContinues: true,
  }

  let pageNumber = 0
  doc.on("pageAdded", () => {
    pageNumber += 1
    if (pageNumber === 1) drawFirstPageChrome(ctx)
    else drawContinuationChrome(ctx)
  })

  const rowHeights = measureRowHeights(ctx)
  doc.addPage()
  const tableEndY = drawLedgerTable(ctx, rowHeights)
  const afterTotals = drawTotals(ctx, tableEndY)
  const afterBanner = drawTruncationBanner(ctx, afterTotals)
  drawIssuerBlock(ctx, issuerBlockTop(ctx, afterBanner))
  drawFooters(ctx)

  doc.end()
  return bytes
}

function formatDate(value: Date, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeZone: CERTIFICATE_TIME_ZONE,
  }).format(value)
}

// The seal year must agree with the Issued date printed beside it, which is in the certificate zone.
function formatYear(value: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    timeZone: CERTIFICATE_TIME_ZONE,
  }).format(value)
}

function formatNumber(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: Number.isInteger(value) ? 0 : 1,
    maximumFractionDigits: 2,
  }).format(value)
}
