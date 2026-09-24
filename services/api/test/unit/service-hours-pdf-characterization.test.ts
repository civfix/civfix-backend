/**
 * Characterization of `buildServiceHoursPdf` ahead of splitting it into helpers.
 *
 * certificate-pdf.test.ts deliberately avoids byte snapshots so ordinary copy or pdfkit changes do not
 * churn it. This file is the opposite on purpose: it exists to prove a behavior-neutral refactor is
 * neutral, so it pins the sha256 of the bytes (the renderer is deterministic for a fixed model, code and
 * issue time) and, because a hash mismatch alone says nothing about WHAT moved, it also pins the ordered
 * sequence of drawing calls (every `doc.text`, page add/switch and font registration) that produced
 * them. If a pdfkit or font upgrade changes the hashes, re-derive them in that upgrade's PR; a refactor
 * PR must not touch them.
 */

import { createHash } from "node:crypto"
import PDFDocument from "pdfkit"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  buildTranscriptModel,
  certificateTranslator,
  type CertificateTranslator,
  type TranscriptHolder,
  type TranscriptLedgerRow,
  type TranscriptModel,
} from "../../src/services/certificate-model.js"
import {
  buildServiceHoursPdf,
  type ServiceHoursPdfInput,
} from "../../src/services/certificate-pdf.js"

const CODE = "A1B2C3D4E5F6"
const ISSUED_AT = new Date("2026-07-27T18:22:04.000Z")
const FINGERPRINT = "0123456789abcdef".repeat(4)

// Echoes the key (and its vars) so every drawn string names the message it came from and the pins do
// not move when catalog copy is edited.
const t: CertificateTranslator = (key, vars) => (vars ? `${key}(${JSON.stringify(vars)})` : key)

const HOLDER: TranscriptHolder = {
  userId: "11111111-1111-4111-8111-111111111111",
  displayName: "Jane Doe",
  handle: "jane",
}

function ledger(count: number, over: Partial<TranscriptLedgerRow> = {}): TranscriptLedgerRow[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `row-${String(i).padStart(5, "0")}`,
    source: "event" as const,
    hours: 2.5,
    occurredAt: new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString(),
    eventTitle: "Beach cleanup at the pier",
    jurisdictionName: "Los Angeles",
    creditedByName: "Ada Host",
    ...over,
  }))
}

const MIXED_ROWS: TranscriptLedgerRow[] = [
  {
    id: "r1",
    source: "event",
    hours: 3.25,
    occurredAt: "2026-03-14T17:00:00.000Z",
    eventTitle: "Riverbank litter sweep",
    jurisdictionName: "Los Angeles",
    creditedByName: "Ada Host",
  },
  {
    id: "r2",
    source: "report",
    hours: 0.5,
    occurredAt: "2026-04-02T20:30:00.000Z",
    reportReferenceCode: "RPT-7Q2K",
    jurisdictionName: "Pasadena",
  },
  {
    id: "r3",
    source: "manual",
    hours: 1.75,
    occurredAt: "2026-05-09T16:00:00.000Z",
    jurisdictionName: "Santa Monica",
    creditedByName: null,
  },
]

function enModel(rows: TranscriptLedgerRow[], holder: TranscriptHolder = HOLDER): TranscriptModel {
  return buildTranscriptModel({ holder, locale: "en", t, rows })
}

type DrawEvent =
  | [op: "text", text: string, x: number, y: number]
  | [op: "addPage"]
  | [op: "switchToPage", page: number]
  | [op: "registerFont", name: string]

type Proto = Record<string, (...args: unknown[]) => unknown>

function round(n: unknown): number {
  return Math.round(Number(n) * 1000) / 1000
}

/** Records drawing calls on every PDFDocument while still delegating to pdfkit, so bytes are unchanged. */
function recordDrawing(): DrawEvent[] {
  const events: DrawEvent[] = []
  const proto = PDFDocument.prototype as unknown as Proto
  const wrap = (name: string, toEvent: (args: unknown[]) => DrawEvent) => {
    const original = proto[name]
    if (!original) throw new Error(`pdfkit has no ${name}`)
    vi.spyOn(proto, name).mockImplementation(function (this: unknown, ...args: unknown[]) {
      events.push(toEvent(args))
      return original.apply(this, args)
    })
  }
  wrap("text", (a) => ["text", String(a[0]), round(a[1]), round(a[2])])
  wrap("addPage", () => ["addPage"])
  wrap("switchToPage", (a) => ["switchToPage", Number(a[0])])
  wrap("registerFont", (a) => ["registerFont", String(a[0])])
  return events
}

afterEach(() => {
  vi.restoreAllMocks()
})

async function render(input: Partial<ServiceHoursPdfInput> & { model: TranscriptModel }) {
  const events = recordDrawing()
  const bytes = await buildServiceHoursPdf({ code: CODE, issuedAt: ISSUED_AT, t, ...input })
  vi.restoreAllMocks()
  return { bytes, events }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function latin1(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("latin1")
}

function pageCount(bytes: Uint8Array): number {
  return (latin1(bytes).match(/\/Type \/Page(?!s)/g) ?? []).length
}

function objectCount(bytes: Uint8Array): number {
  return (latin1(bytes).match(/^\d+ 0 obj$/gm) ?? []).length
}

/** The trailer's Info dictionary, each value resolved to the raw body of its indirect object. */
function infoDictionary(bytes: Uint8Array): Record<string, string> {
  const pdf = latin1(bytes)
  const objectBody = (id: string): string => {
    const match = new RegExp(`^${id} 0 obj\\n([\\s\\S]*?)\\nendobj$`, "m").exec(pdf)
    if (!match?.[1]) throw new Error(`object ${id} not found`)
    return match[1]
  }
  const infoId = /\/Info (\d+) 0 R/.exec(pdf.slice(pdf.lastIndexOf("trailer")))?.[1]
  if (!infoId) throw new Error("no Info in trailer")
  const out: Record<string, string> = {}
  for (const [, key, ref] of objectBody(infoId).matchAll(/\/(\w+) (\d+) 0 R/g)) {
    if (!key || !ref) continue
    const body = objectBody(ref)
    // pdfkit writes non-ASCII strings as UTF-16BE behind a BOM, which is not printable.
    out[key] = /^[\x20-\x7e]*$/.test(body)
      ? body
      : `hex:${Buffer.from(body, "latin1").toString("hex")}`
  }
  return out
}

// The empty-cell placeholder is U+2014; it is spelled as an escape so this file stays plain text.
function texts(events: DrawEvent[]): string[] {
  return events.map((e) =>
    e[0] === "text" ? `${e[1].replaceAll("\u2014", "<U+2014>")} @${e[2]},${e[3]}` : e.join(" "),
  )
}

describe("buildServiceHoursPdf characterization: one-page document", () => {
  it("is byte-identical across builds and pins the sha256, size, pages and object count", async () => {
    const model = enModel(MIXED_ROWS)
    const a = await render({ model, fingerprint: FINGERPRINT })
    const b = await render({ model, fingerprint: FINGERPRINT })
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true)
    expect(sha256(a.bytes)).toBe("346215f9f7d53bfe81752146d887fbeb61b882fd107c4e6adc6132fd67c681a6")
    expect(a.bytes.length).toBe(26599)
    expect(pageCount(a.bytes)).toBe(1)
    expect(objectCount(a.bytes)).toBe(43)
  })

  it("draws every string in this exact order and position", async () => {
    const { events } = await render({ model: enModel(MIXED_ROWS), fingerprint: FINGERPRINT })
    expect(texts(events)).toMatchInlineSnapshot(`
      [
        "registerFont HankenGrotesk-Regular.ttf",
        "addPage",
        "registerFont Baloo2-ExtraBold.ttf",
        "civfix @54,54",
        "registerFont BricolageGrotesque-SemiBold.ttf",
        "CERTIFICATE.DOC.TITLE @54,86",
        "CERTIFICATE.HEADER.NUMBER @330,56",
        "registerFont JetBrainsMono-Regular.ttf",
        "CFX-A1B2-C3D4-E5F6 @330,68",
        "CERTIFICATE.HOLDER.EYEBROW @70,140",
        "Jane Doe @70,154",
        "@jane @70,182",
        "CERTIFICATE.HOLDER.PERIOD @366,140",
        "Mar 14, 2026 – May 9, 2026 @366,151",
        "CERTIFICATE.HOLDER.ISSUED @366,174",
        "Jul 27, 2026 @366,185",
        "CERTIFICATE.SUMMARY.TOTAL_HOURS @68,242",
        "5.5 @68,256",
        "CERTIFICATE.SUMMARY.ACTIVITIES @240,242",
        "3 @240,256",
        "CERTIFICATE.SUMMARY.COMMUNITIES @412,242",
        "3 @412,256",
        "Los Angeles, Pasadena certificate.summary.more({"count":1}) @412,290",
        "CERTIFICATE.TABLE.DATE @60,329",
        "CERTIFICATE.TABLE.ACTIVITY @122,329",
        "CERTIFICATE.TABLE.COMMUNITY @316,329",
        "CERTIFICATE.TABLE.HOURS @414,329",
        "CERTIFICATE.TABLE.CREDITED_BY @466,329",
        "Mar 14, 2026 @60,350",
        "Riverbank litter sweep @122,350",
        "Los Angeles @316,350",
        "3.25 @414,350",
        "Ada Host @466,350",
        "Apr 2, 2026 @60,370.379",
        "certificate.activity.report({"ref":"RPT-7Q2K"}) @122,370.379",
        "Pasadena @316,370.379",
        "0.50 @414,370.379",
        "certificate.credited_by.automatic @466,370.379",
        "May 9, 2026 @60,403.136",
        "certificate.activity.manual @122,403.136",
        "Santa Monica @316,403.136",
        "1.75 @414,403.136",
        "certificate.credited_by.automatic @466,403.136",
        "registerFont HankenGrotesk-SemiBold.ttf",
        "CERTIFICATE.TABLE.TOTAL @122,427.514",
        "5.50 @414,427.514",
        "certificate.attestation.body @54,471.514",
        "CIVFIX @54,523.892",
        "CERTIFICATE.SEAL.LINE @54,537.892",
        "2026 @54,547.892",
        "certificate.issuer.line @54,583.892",
        "certificate.issuer.generated({"timestamp":"2026-07-27T18:22:04Z"}) @54,595.892",
        "certificate.verify.prompt @306,509.892",
        "CFX-A1B2-C3D4-E5F6 @306,539.892",
        "certificate.verify.fingerprint @306,555.892",
        "0123456789abcdef @306,564.892",
        "switchToPage 0",
        "CFX-A1B2-C3D4-E5F6 · Jul 27, 2026 @54,746",
        "civfix.org/service-record @206,746",
        "certificate.footer.page({"page":1,"total":1}) @358,746",
        "certificate.footer.timezone @54,758",
      ]
    `)
  })

  it("pins the Info dictionary, with both dates taken from issuedAt", async () => {
    const { bytes } = await render({ model: enModel(MIXED_ROWS), fingerprint: FINGERPRINT })
    expect(infoDictionary(bytes)).toMatchInlineSnapshot(`
      {
        "Author": "(civfix)",
        "CreationDate": "(D:20260727182204Z)",
        "Creator": "(civfix)",
        "Keywords": "(CFX-A1B2-C3D4-E5F6)",
        "ModDate": "(D:20260727182204Z)",
        "Producer": "(civfix)",
        "Subject": "(certificate.doc.title)",
        "Title": "(certificate.doc.pdf_title\\({"name":"Jane Doe","code":"CFX-A1B2-C3D4-E5F6"}\\))",
      }
    `)
  })

  it("accepts issuedAt as an ISO string with byte-identical output", async () => {
    const model = enModel(MIXED_ROWS)
    const asDate = await render({ model, fingerprint: FINGERPRINT })
    const asString = await render({
      model,
      fingerprint: FINGERPRINT,
      issuedAt: ISSUED_AT.toISOString(),
    })
    expect(sha256(asString.bytes)).toBe(sha256(asDate.bytes))
  })

  it("defaults t to the model locale's catalog translator", async () => {
    const model = enModel(MIXED_ROWS)
    const implicit = await buildServiceHoursPdf({ model, code: CODE, issuedAt: ISSUED_AT })
    const explicit = await buildServiceHoursPdf({
      model,
      code: CODE,
      issuedAt: ISSUED_AT,
      t: certificateTranslator("en"),
    })
    expect(sha256(implicit)).toBe(sha256(explicit))
  })

  it("encodes verifyBaseUrl only in the QR code: the footer URL stays hardcoded (pinned as-is)", async () => {
    const model = enModel(MIXED_ROWS)
    const standard = await render({ model })
    const custom = await render({ model, verifyBaseUrl: "https://staging.example/verify" })
    expect(sha256(custom.bytes)).not.toBe(sha256(standard.bytes))
    expect(texts(custom.events)).toEqual(texts(standard.events))
    expect(texts(custom.events)).toContain("civfix.org/service-record @206,746")
    expect(sha256(custom.bytes)).toBe(
      "1857513bd037dd3ad7fc247091da4d3fb4146dc7d436d9c97320f7df979fa184",
    )
  })
})

describe("buildServiceHoursPdf characterization: empty ledger, no handle, no fingerprint", () => {
  it("pins the bytes and the drawing sequence", async () => {
    const model = enModel([], { ...HOLDER, handle: null })
    const { bytes, events } = await render({ model })
    expect(sha256(bytes)).toBe("63fa1ac929957b166d2e4c37a415b249d985b3f9079061046e3a9b1ae5f478e2")
    expect(bytes.length).toBe(24775)
    expect(pageCount(bytes)).toBe(1)
    expect(texts(events)).toMatchInlineSnapshot(`
      [
        "addPage",
        "registerFont Baloo2-ExtraBold.ttf",
        "civfix @54,54",
        "registerFont BricolageGrotesque-SemiBold.ttf",
        "CERTIFICATE.DOC.TITLE @54,86",
        "CERTIFICATE.HEADER.NUMBER @330,56",
        "registerFont JetBrainsMono-Regular.ttf",
        "CFX-A1B2-C3D4-E5F6 @330,68",
        "CERTIFICATE.HOLDER.EYEBROW @70,140",
        "Jane Doe @70,154",
        "CERTIFICATE.HOLDER.PERIOD @366,140",
        "registerFont HankenGrotesk-Regular.ttf",
        "<U+2014> @366,151",
        "CERTIFICATE.HOLDER.ISSUED @366,174",
        "Jul 27, 2026 @366,185",
        "CERTIFICATE.SUMMARY.TOTAL_HOURS @68,242",
        "0 @68,256",
        "CERTIFICATE.SUMMARY.ACTIVITIES @240,242",
        "0 @240,256",
        "CERTIFICATE.SUMMARY.COMMUNITIES @412,242",
        "0 @412,256",
        "CERTIFICATE.TABLE.DATE @60,329",
        "CERTIFICATE.TABLE.ACTIVITY @122,329",
        "CERTIFICATE.TABLE.COMMUNITY @316,329",
        "CERTIFICATE.TABLE.HOURS @414,329",
        "CERTIFICATE.TABLE.CREDITED_BY @466,329",
        "registerFont HankenGrotesk-SemiBold.ttf",
        "CERTIFICATE.TABLE.TOTAL @122,354",
        "0.00 @414,354",
        "certificate.attestation.body @54,398",
        "CIVFIX @54,450.379",
        "CERTIFICATE.SEAL.LINE @54,464.379",
        "2026 @54,474.379",
        "certificate.issuer.line @54,510.379",
        "certificate.issuer.generated({"timestamp":"2026-07-27T18:22:04Z"}) @54,522.379",
        "certificate.verify.prompt @306,436.379",
        "CFX-A1B2-C3D4-E5F6 @306,466.379",
        "switchToPage 0",
        "CFX-A1B2-C3D4-E5F6 · Jul 27, 2026 @54,746",
        "civfix.org/service-record @206,746",
        "certificate.footer.page({"page":1,"total":1}) @358,746",
        "certificate.footer.timezone @54,758",
      ]
    `)
  })
})

describe("buildServiceHoursPdf characterization: page-break branches", () => {
  // At 20.3785pt per single-line row, 18 rows fill page 1 (344 + 18 x 20.3785 = 710.8 of a 730 floor).
  it("17 rows: totals fit on page 1, the issuer block is forced onto page 2 with no column band", async () => {
    const { bytes, events } = await render({ model: enModel(ledger(17)), fingerprint: FINGERPRINT })
    expect(sha256(bytes)).toBe("722ace803b2da7da08089ff1c7ff952593777d97cae663991471a4fba7317e7c")
    expect(bytes.length).toBe(27593)
    expect(pageCount(bytes)).toBe(2)
    expect(events.length).toBe(138)
    const fromTotals = texts(events).slice(
      texts(events).findIndex((s) => s.startsWith("CERTIFICATE.TABLE.TOTAL ")),
    )
    expect(fromTotals).toMatchInlineSnapshot(`
      [
        "CERTIFICATE.TABLE.TOTAL @122,700.435",
        "42.50 @414,700.435",
        "addPage",
        "civfix @54,40",
        "certificate.doc.title · Jane Doe · CFX-A1B2-C3D4-E5F6 @150,42",
        "certificate.attestation.body @54,100",
        "CIVFIX @54,152.379",
        "CERTIFICATE.SEAL.LINE @54,166.379",
        "2026 @54,176.379",
        "certificate.issuer.line @54,212.379",
        "certificate.issuer.generated({"timestamp":"2026-07-27T18:22:04Z"}) @54,224.379",
        "certificate.verify.prompt @306,138.379",
        "CFX-A1B2-C3D4-E5F6 @306,168.379",
        "certificate.verify.fingerprint @306,184.379",
        "0123456789abcdef @306,193.379",
        "switchToPage 0",
        "CFX-A1B2-C3D4-E5F6 · Jul 27, 2026 @54,746",
        "civfix.org/service-record @206,746",
        "certificate.footer.page({"page":1,"total":2}) @358,746",
        "certificate.footer.timezone @54,758",
        "switchToPage 1",
        "CFX-A1B2-C3D4-E5F6 · Jul 27, 2026 @54,746",
        "civfix.org/service-record @206,746",
        "certificate.footer.page({"page":2,"total":2}) @358,746",
      ]
    `)
  })

  it("18 rows: the totals row itself is forced onto page 2 with no column band", async () => {
    const { bytes, events } = await render({ model: enModel(ledger(18)), fingerprint: FINGERPRINT })
    expect(sha256(bytes)).toBe("49c650a2b8c6ec30b0b85c9bd77dd6d40dfe36c2f156d074152fe5e4a8ef6ae9")
    expect(bytes.length).toBe(27665)
    expect(pageCount(bytes)).toBe(2)
    expect(events.length).toBe(143)
    const all = texts(events)
    const fromLastRow = all.slice(all.map((s) => s.startsWith("Ada Host ")).lastIndexOf(true))
    expect(fromLastRow).toMatchInlineSnapshot(`
      [
        "Ada Host @466,696.435",
        "addPage",
        "civfix @54,40",
        "certificate.doc.title · Jane Doe · CFX-A1B2-C3D4-E5F6 @150,42",
        "registerFont HankenGrotesk-SemiBold.ttf",
        "CERTIFICATE.TABLE.TOTAL @122,110",
        "45.00 @414,110",
        "certificate.attestation.body @54,154",
        "CIVFIX @54,206.378",
        "CERTIFICATE.SEAL.LINE @54,220.378",
        "2026 @54,230.378",
        "certificate.issuer.line @54,266.379",
        "certificate.issuer.generated({"timestamp":"2026-07-27T18:22:04Z"}) @54,278.379",
        "certificate.verify.prompt @306,192.378",
        "CFX-A1B2-C3D4-E5F6 @306,222.378",
        "certificate.verify.fingerprint @306,238.378",
        "0123456789abcdef @306,247.378",
        "switchToPage 0",
        "CFX-A1B2-C3D4-E5F6 · Jul 27, 2026 @54,746",
        "civfix.org/service-record @206,746",
        "certificate.footer.page({"page":1,"total":2}) @358,746",
        "certificate.footer.timezone @54,758",
        "switchToPage 1",
        "CFX-A1B2-C3D4-E5F6 · Jul 27, 2026 @54,746",
        "civfix.org/service-record @206,746",
        "certificate.footer.page({"page":2,"total":2}) @358,746",
      ]
    `)
  })

  it("19 rows: the table continues onto page 2 under a redrawn column band", async () => {
    const { bytes, events } = await render({ model: enModel(ledger(19)), fingerprint: FINGERPRINT })
    expect(sha256(bytes)).toBe("5390906d365c434bf538db385a3f6e7f9764653cabb73837478fb9c984de9bce")
    expect(bytes.length).toBe(28006)
    expect(pageCount(bytes)).toBe(2)
    expect(events.length).toBe(153)
    const all = texts(events)
    const page2 = all.slice(all.indexOf("addPage", all.indexOf("addPage") + 1))
    expect(page2).toMatchInlineSnapshot(`
      [
        "addPage",
        "civfix @54,40",
        "certificate.doc.title · Jane Doe · CFX-A1B2-C3D4-E5F6 @150,42",
        "CERTIFICATE.TABLE.DATE @60,85",
        "CERTIFICATE.TABLE.ACTIVITY @122,85",
        "CERTIFICATE.TABLE.COMMUNITY @316,85",
        "CERTIFICATE.TABLE.HOURS @414,85",
        "CERTIFICATE.TABLE.CREDITED_BY @466,85",
        "Jan 18, 2026 @60,106",
        "Beach cleanup at the pier @122,106",
        "Los Angeles @316,106",
        "2.50 @414,106",
        "Ada Host @466,106",
        "registerFont HankenGrotesk-SemiBold.ttf",
        "CERTIFICATE.TABLE.TOTAL @122,130.379",
        "47.50 @414,130.379",
        "certificate.attestation.body @54,174.379",
        "CIVFIX @54,226.757",
        "CERTIFICATE.SEAL.LINE @54,240.757",
        "2026 @54,250.757",
        "certificate.issuer.line @54,286.757",
        "certificate.issuer.generated({"timestamp":"2026-07-27T18:22:04Z"}) @54,298.757",
        "certificate.verify.prompt @306,212.757",
        "CFX-A1B2-C3D4-E5F6 @306,242.757",
        "certificate.verify.fingerprint @306,258.757",
        "0123456789abcdef @306,267.757",
        "switchToPage 0",
        "CFX-A1B2-C3D4-E5F6 · Jul 27, 2026 @54,746",
        "civfix.org/service-record @206,746",
        "certificate.footer.page({"page":1,"total":2}) @358,746",
        "certificate.footer.timezone @54,758",
        "switchToPage 1",
        "CFX-A1B2-C3D4-E5F6 · Jul 27, 2026 @54,746",
        "civfix.org/service-record @206,746",
        "certificate.footer.page({"page":2,"total":2}) @358,746",
      ]
    `)
  })

  it("40 rows: three pages, footers stamped last in page order", async () => {
    const { bytes, events } = await render({ model: enModel(ledger(40)) })
    expect(sha256(bytes)).toBe("250921c249066b959460af0c680130e74282df78d628f627fcf86130e229b087")
    expect(bytes.length).toBe(29306)
    expect(pageCount(bytes)).toBe(3)
    expect(objectCount(bytes)).toBe(49)
    const pageOps = events.filter((e) => e[0] === "addPage" || e[0] === "switchToPage")
    expect(pageOps).toMatchInlineSnapshot(`
      [
        [
          "addPage",
        ],
        [
          "addPage",
        ],
        [
          "addPage",
        ],
        [
          "switchToPage",
          0,
        ],
        [
          "switchToPage",
          1,
        ],
        [
          "switchToPage",
          2,
        ],
      ]
    `)
    const firstSwitch = texts(events).indexOf("switchToPage 0")
    expect(texts(events).slice(firstSwitch)).toMatchInlineSnapshot(`
      [
        "switchToPage 0",
        "CFX-A1B2-C3D4-E5F6 · Jul 27, 2026 @54,746",
        "civfix.org/service-record @206,746",
        "certificate.footer.page({"page":1,"total":3}) @358,746",
        "certificate.footer.timezone @54,758",
        "switchToPage 1",
        "CFX-A1B2-C3D4-E5F6 · Jul 27, 2026 @54,746",
        "civfix.org/service-record @206,746",
        "certificate.footer.page({"page":2,"total":3}) @358,746",
        "switchToPage 2",
        "CFX-A1B2-C3D4-E5F6 · Jul 27, 2026 @54,746",
        "civfix.org/service-record @206,746",
        "certificate.footer.page({"page":3,"total":3}) @358,746",
      ]
    `)
  })
})

describe("buildServiceHoursPdf characterization: truncation banner", () => {
  it("draws the banner between the totals and the attestation when totals exceed the rows", async () => {
    const model = buildTranscriptModel({
      holder: HOLDER,
      locale: "en",
      t,
      rows: ledger(3),
      totals: { entryCount: 1234, totalHours: 4321.5 },
    })
    expect(model.truncated).toBe(true)
    const { bytes, events } = await render({ model, fingerprint: FINGERPRINT })
    expect(sha256(bytes)).toBe("1057a486a1997894d45aa09d385d696dd16487459f084b97f05d5c7fe2c2eef6")
    expect(pageCount(bytes)).toBe(1)
    const fromTotals = texts(events).slice(
      texts(events).findIndex((s) => s.startsWith("CERTIFICATE.TABLE.TOTAL ")),
    )
    expect(fromTotals.slice(0, 4)).toMatchInlineSnapshot(`
      [
        "CERTIFICATE.TABLE.TOTAL @122,415.135",
        "4321.50 @414,415.135",
        "certificate.table.truncated({"shown":"3","total":"1,234"}) @54,435.135",
        "certificate.attestation.body @54,481.135",
      ]
    `)
  })
})

describe("buildServiceHoursPdf characterization: Hangul transcript", () => {
  it("pins the bytes and the lazy font registration order", async () => {
    const model = buildTranscriptModel({
      holder: { ...HOLDER, displayName: "홍길동", handle: null },
      locale: "ko",
      t,
      rows: ledger(3, {
        eventTitle: "강남구 정화 활동",
        jurisdictionName: "강남구",
        creditedByName: "김호스트",
      }),
    })
    const a = await render({ model, fingerprint: FINGERPRINT })
    const b = await render({ model, fingerprint: FINGERPRINT })
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true)
    expect(sha256(a.bytes)).toBe("177a50ffdabd4f2c8832cbe1ac9824d6a186923f0bfef8f0a211f755c4e94649")
    expect(a.bytes.length).toBe(54143)
    expect(pageCount(a.bytes)).toBe(1)
    expect(a.events.filter((e) => e[0] === "registerFont")).toMatchInlineSnapshot(`
      [
        [
          "registerFont",
          "NotoSansKR-Regular.otf",
        ],
        [
          "registerFont",
          "Baloo2-ExtraBold.ttf",
        ],
        [
          "registerFont",
          "BricolageGrotesque-SemiBold.ttf",
        ],
        [
          "registerFont",
          "JetBrainsMono-Regular.ttf",
        ],
        [
          "registerFont",
          "HankenGrotesk-Regular.ttf",
        ],
        [
          "registerFont",
          "HankenGrotesk-SemiBold.ttf",
        ],
      ]
    `)
    expect(infoDictionary(a.bytes)).toMatchInlineSnapshot(`
      {
        "Author": "(civfix)",
        "CreationDate": "(D:20260727182204Z)",
        "Creator": "(civfix)",
        "Keywords": "(CFX-A1B2-C3D4-E5F6)",
        "ModDate": "(D:20260727182204Z)",
        "Producer": "(civfix)",
        "Subject": "(certificate.doc.title)",
        "Title": "hex:28feff00630065007200740069006600690063006100740065002e0064006f0063002e007000640066005f007400690074006c0065005c28007b0022006e0061006d00650022003a0022d64dae38b3d90022002c00220063006f006400650022003a0022004300460058002d0041003100420032002d0043003300440034002d00450035004600360022007d005c2929",
      }
    `)
  })
})
