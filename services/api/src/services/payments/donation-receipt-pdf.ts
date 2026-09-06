import { FONT, fontBuffer } from "../certificate-fonts.js"
import {
  formatMoney,
  formatReceiptDate,
  maskEin,
  receiptStatements,
  type DonationReceiptModel,
} from "./donation-receipt-model.js"


type Doc = PDFKit.PDFDocument

const PAGE = {
  left: 54,
  right: 558,
  contentWidth: 504,
} as const

const INK = "#1A1A1A"
const INK_MUTED = "#5A5A5A"
const RULE = "#D8D4CE"

function useFont(doc: Doc, registered: Set<string>, file: string, size: number): Doc {
  if (!registered.has(file)) {
    doc.registerFont(file, fontBuffer(file))
    registered.add(file)
  }
  return doc.font(file).fontSize(size)
}

export async function buildDonationReceiptPdf(model: DonationReceiptModel): Promise<Uint8Array> {
  const PDFDocument = (await import("pdfkit")).default

  const statements = receiptStatements(model)
  const issuedAt = model.contributionDate

  const doc = new PDFDocument({
    size: "LETTER",
    margins: { top: 54, bottom: 54, left: PAGE.left, right: 54 },
    bufferPages: true,
    pdfVersion: "1.7",
    lang: "en",
    displayTitle: true,
    info: {
      Title: `Donation receipt ${model.reference}`,
      Author: "civfix",
      Subject: `Charitable contribution receipt for ${model.donee.legalName}`,
      Keywords: model.reference,
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

  function rule(y: number): void {
    doc.moveTo(PAGE.left, y).lineTo(PAGE.right, y).lineWidth(0.75).strokeColor(RULE).stroke()
  }

  function paragraph(text: string, size = 10, color = INK): void {
    font(FONT.body, size).fillColor(color).text(text, PAGE.left, doc.y, { width: PAGE.contentWidth })
    doc.moveDown(0.5)
  }

  function labelValue(label: string, value: string): void {
    const y = doc.y
    font(FONT.bodyBold, 9).fillColor(INK_MUTED).text(label.toUpperCase(), PAGE.left, y, { width: 180 })
    font(FONT.body, 11).fillColor(INK).text(value, PAGE.left + 190, y, { width: PAGE.contentWidth - 190 })
    doc.moveDown(0.4)
  }

  font(FONT.wordmark, 20).fillColor(INK).text("civfix", PAGE.left, 54)
  font(FONT.display, 18).fillColor(INK).text("Donation receipt", PAGE.left, doc.y + 6)
  font(FONT.mono, 10).fillColor(INK_MUTED).text(model.reference, PAGE.left, doc.y + 2)
  doc.moveDown(1)
  rule(doc.y)
  doc.moveDown(0.8)

  font(FONT.display, 12).fillColor(INK).text("Donee organization", PAGE.left, doc.y)
  doc.moveDown(0.4)
  labelValue("Legal name", model.donee.legalName)
  const ein = maskEin(model.donee.ein)
  if (ein !== null) labelValue("EIN", ein)
  const addressParts = [
    model.donee.addressLine1,
    [model.donee.city, model.donee.state].filter((part) => part !== null).join(", "),
    model.donee.postalCode,
  ].filter((part): part is string => part !== null && part.length > 0)
  if (addressParts.length > 0) labelValue("Address", addressParts.join(" · "))
  if (model.orgContactEmail !== null) labelValue("Organization contact", model.orgContactEmail)
  doc.moveDown(0.6)

  font(FONT.display, 12).fillColor(INK).text("Contribution", PAGE.left, doc.y)
  doc.moveDown(0.4)
  labelValue("Donor", model.donor.name ?? model.donor.email)
  labelValue("Donor email", model.donor.email)
  labelValue("Amount", formatMoney(model.amountMinor))
  labelValue("Date of contribution", formatReceiptDate(model.contributionDate))
  labelValue("Donation id", model.donationId)
  doc.moveDown(0.6)

  font(FONT.display, 12).fillColor(INK).text("How the amount was applied", PAGE.left, doc.y)
  doc.moveDown(0.4)
  labelValue("Gross contribution", formatMoney(model.fees.grossMinor))
  labelValue(
    `civfix platform fee (${(model.fees.platformFeeBps / 100).toFixed(2)}%)`,
    formatMoney(model.fees.platformFeeMinor),
  )
  labelValue(
    "Payment processing fee",
    model.fees.processorFeeMinor === null
      ? "Charged to the organization by its payment processor"
      : formatMoney(model.fees.processorFeeMinor),
  )
  labelValue(
    "Net to the organization",
    model.fees.netMinor === null ? "Settles to the organization" : formatMoney(model.fees.netMinor),
  )
  doc.moveDown(0.6)
  rule(doc.y)
  doc.moveDown(0.8)

  paragraph(statements.noGoodsOrServices, 10)
  paragraph(statements.deductibility, 10)
  if (statements.cwa !== null) paragraph(statements.cwa, 10)
  if (statements.refunded !== null) paragraph(statements.refunded, 10)
  paragraph(statements.agent, 9, INK_MUTED)
  paragraph(
    `${model.donee.legalName} is the merchant of record for this payment. civfix never holds the funds.`,
    9,
    INK_MUTED,
  )
  if (model.registrationNumber !== null) {
    paragraph(
      `civfix is a registered charitable fundraising platform in California. Registration number ${model.registrationNumber}.`,
      9,
      INK_MUTED,
    )
  }

  doc.end()
  await finished
  return new Uint8Array(Buffer.concat(chunks))
}
