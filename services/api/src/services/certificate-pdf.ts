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

export const CERTIFICATE_VERIFY_PATH = "/service-record"

export const CERTIFICATE_VERIFY_BASE_URL = `https://civfix.org${CERTIFICATE_VERIFY_PATH}`

export interface ServiceHoursPdfInput {
  model: TranscriptModel
  code: string
  issuedAt: Date | string
  fingerprint?: string | null
  verifyBaseUrl?: string
  t?: CertificateTranslator
}

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

const ROW_MIN_HEIGHT = 20
const ROW_PADDING = 8

type Doc = PDFKit.PDFDocument

function useFont(doc: Doc, registered: Set<string>, file: string, size: number): Doc {
  if (!registered.has(file)) {
    doc.registerFont(file, fontBuffer(file))
    registered.add(file)
  }
  return doc.font(file).fontSize(size)
}

function displayFont(text: string): string {
  return fontFor(text, "bold") === FONT.cjk ? FONT.cjk : FONT.display
}

function toDate(value: Date | string): Date {
  return typeof value === "string" ? new Date(value) : value
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
  const verifyUrl = `${verifyBaseUrl}/${displayCode}`
  const verifyLabel = verifyBaseUrl.replace(/^https?:\/\//, "")
  const holderName = model.holder.displayName
  const issuedLabel = formatDate(issuedAt, locale)

  const doc = new PDFDocument({
    size: "LETTER",
    margins: { top: 48, bottom: 54, left: 54, right: 54 },
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
  let tableContinues = true
  doc.on("pageAdded", () => {
    pageNumber += 1
    if (pageNumber === 1) drawFirstPageChrome()
    else drawContinuationChrome()
  })

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
    const rx = 366
    const rw = 176
    const period =
      model.periodStart && model.periodEnd
        ? `${formatDate(new Date(model.periodStart), locale)} – ${formatDate(new Date(model.periodEnd), locale)}`
        : "—"
    labelledValue(rx, top + 14, rw, t("certificate.holder.period"), period)
    labelledValue(rx, top + 48, rw, t("certificate.holder.issued"), issuedLabel)
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

    const sealX = PAGE.left
    const cx = sealX + 34
    const cy = blockTop + 34
    doc.circle(cx, cy, 34).lineWidth(1.5).strokeColor(COLOR.accent).stroke()
    doc.circle(cx, cy, 29).lineWidth(1).strokeColor(COLOR.accent).stroke()
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
    line(FONT.mono, 8, COLOR.ink3, formatYear(issuedAt), sealX, cy + 8, {
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
      t("certificate.issuer.generated", {
        timestamp: issuedAt.toISOString().replace(/\.\d{3}Z$/, "Z"),
      }),
      sealX,
      blockTop + 90,
      { width: 260 },
    )

    drawQr(verifyUrl, 474, blockTop, 84)
    const textX = 306
    const textW = 156
    const prompt = t("certificate.verify.prompt", { url: verifyLabel })
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

  const range = doc.bufferedPageRange()
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i)
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
    line(FONT.body, 7.5, COLOR.ink3, verifyLabel, 206, PAGE.footerText, {
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
