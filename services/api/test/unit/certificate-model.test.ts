/**
 * The transcript model (DP §8.1) — the bulk of the document's correctness, proven without pdfkit.
 *
 * Every test injects its own translator, so the assertions describe DERIVATION (which label a row gets,
 * what the totals cover) and never the English copy, which lands with the i18n block in WP21.
 */

import { MAX_CERTIFICATE_ENTRIES } from "@civfix/shared"
import { describe, expect, it } from "vitest"
import {
  CERTIFICATE_MESSAGE_KEYS,
  CERTIFICATE_TIME_ZONE,
  buildTranscriptModel,
  certificateTranslator,
  communitiesLabel,
  ledgerFingerprint,
  type CertificateTranslator,
  type TranscriptLedgerRow,
} from "../../src/services/certificate-model.js"

/** Renders "key" or "key(a=1,b=2)" so a test can assert exactly which key + vars a field came from. */
const t: CertificateTranslator = (key, vars) => {
  const rendered = vars
    ? `(${Object.entries(vars)
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(",")})`
    : ""
  return `${key}${rendered}`
}

const HOLDER = {
  userId: "11111111-1111-4111-8111-111111111111",
  displayName: "Jane Doe",
  handle: "jane",
  verified: true,
}

function row(over: Partial<TranscriptLedgerRow> & { id: string }): TranscriptLedgerRow {
  return {
    source: "event",
    hours: 2,
    occurredAt: "2026-03-03T18:00:00.000Z",
    eventTitle: "Beach cleanup",
    jurisdictionName: "Los Angeles",
    creditedByName: "Ada Host",
    ...over,
  }
}

describe("buildTranscriptModel", () => {
  it("totals, counts and the period describe the ledger", () => {
    const model = buildTranscriptModel({
      holder: HOLDER,
      locale: "en",
      t,
      rows: [
        row({ id: "b", hours: 2.5, occurredAt: "2026-05-02T17:00:00.000Z" }),
        row({ id: "a", hours: 1.25, occurredAt: "2026-03-03T18:00:00.000Z" }),
        row({ id: "c", hours: 3, occurredAt: "2026-07-26T16:00:00.000Z" }),
      ],
    })

    expect(model.v).toBe(1)
    expect(model.locale).toBe("en")
    expect(model.totalHours).toBe(6.75)
    expect(model.entryCount).toBe(3)
    expect(model.includedCount).toBe(3)
    expect(model.truncated).toBe(false)
    expect(model.rows.map((r) => r.id)).toEqual(["a", "b", "c"])
    expect(model.periodStart).toBe("2026-03-03T18:00:00.000Z")
    expect(model.periodEnd).toBe("2026-07-26T16:00:00.000Z")
  })

  it("sorts ascending by occurredAt and breaks ties on id", () => {
    const at = "2026-04-01T12:00:00.000Z"
    const model = buildTranscriptModel({
      holder: HOLDER,
      locale: "en",
      t,
      rows: [
        row({ id: "c", occurredAt: at }),
        row({ id: "a", occurredAt: at }),
        row({ id: "b", occurredAt: at }),
      ],
    })
    expect(model.rows.map((r) => r.id)).toEqual(["a", "b", "c"])
  })

  it("leaves the period null on an empty ledger", () => {
    const model = buildTranscriptModel({ holder: HOLDER, locale: "en", t, rows: [] })
    expect(model.rows).toEqual([])
    expect(model.totalHours).toBe(0)
    expect(model.entryCount).toBe(0)
    expect(model.periodStart).toBeNull()
    expect(model.periodEnd).toBeNull()
    expect(model.jurisdictions).toEqual([])
  })

  it("derives activity + creditedBy per source", () => {
    const model = buildTranscriptModel({
      holder: HOLDER,
      locale: "en",
      t,
      rows: [
        row({ id: "a", occurredAt: "2026-01-01T00:00:00.000Z" }),
        row({
          id: "b",
          source: "report",
          occurredAt: "2026-01-02T00:00:00.000Z",
          hours: 0.1,
          eventTitle: null,
          reportReferenceCode: "R-2026-001",
          creditedByName: "should be ignored",
        }),
        row({
          id: "c",
          source: "manual",
          occurredAt: "2026-01-03T00:00:00.000Z",
          eventTitle: null,
          creditedByName: "Ops Operator",
        }),
      ],
    })

    const [event, report, manual] = model.rows
    expect(event?.activity).toBe("Beach cleanup")
    expect(event?.creditedBy).toBe("Ada Host")
    // A report credit is awarded by the PLATFORM; naming a person there would be a fabricated claim.
    expect(report?.activity).toBe("certificate.activity.report(ref=R-2026-001)")
    expect(report?.creditedBy).toBe("certificate.credited_by.automatic")
    expect(manual?.activity).toBe("certificate.activity.manual")
    expect(manual?.creditedBy).toBe("Ops Operator")
  })

  it("falls back to the automatic label when an event row has no crediting host", () => {
    const model = buildTranscriptModel({
      holder: HOLDER,
      locale: "en",
      t,
      rows: [row({ id: "a", creditedByName: null })],
    })
    expect(model.rows[0]?.creditedBy).toBe("certificate.credited_by.automatic")
  })

  it("prints an em dash rather than inventing a name for a titleless event row", () => {
    const model = buildTranscriptModel({
      holder: HOLDER,
      locale: "en",
      t,
      rows: [
        row({ id: "a", eventTitle: null, eventReferenceCode: "E-2026-0007" }),
        row({
          id: "b",
          eventTitle: "   ",
          eventReferenceCode: null,
          occurredAt: "2026-06-01T00:00:00.000Z",
        }),
      ],
    })
    expect(model.rows[0]?.activity).toBe("E-2026-0007")
    expect(model.rows[1]?.activity).toBe("—")
  })

  it("prints an em dash for a row with no community and lists distinct communities", () => {
    const model = buildTranscriptModel({
      holder: HOLDER,
      locale: "en",
      t,
      rows: [
        row({ id: "a", jurisdictionName: null, occurredAt: "2026-01-01T00:00:00.000Z" }),
        row({ id: "b", jurisdictionName: "  ", occurredAt: "2026-01-02T00:00:00.000Z" }),
        row({ id: "c", jurisdictionName: "Santa Monica", occurredAt: "2026-01-03T00:00:00.000Z" }),
        row({ id: "d", jurisdictionName: "Santa Monica", occurredAt: "2026-01-04T00:00:00.000Z" }),
        row({ id: "e", jurisdictionName: "Los Angeles", occurredAt: "2026-01-05T00:00:00.000Z" }),
      ],
    })
    expect(model.rows[0]?.community).toBe("—")
    expect(model.rows[1]?.community).toBe("—")
    expect(model.jurisdictions).toEqual(["Santa Monica", "Los Angeles"])
  })

  it("truncates the table at the cap while the totals still cover the whole ledger", () => {
    const total = MAX_CERTIFICATE_ENTRIES + 842
    const rows = Array.from({ length: total }, (_, i) =>
      row({
        id: `row-${String(i).padStart(5, "0")}`,
        hours: 1,
        occurredAt: new Date(Date.UTC(2020, 0, 1) + i * 86_400_000).toISOString(),
      }),
    )

    const model = buildTranscriptModel({ holder: HOLDER, locale: "en", t, rows })

    expect(model.truncated).toBe(true)
    expect(model.rows).toHaveLength(MAX_CERTIFICATE_ENTRIES)
    expect(model.includedCount).toBe(MAX_CERTIFICATE_ENTRIES)
    // The full ledger, not the printed subset: refusing the most prolific volunteers a document, or
    // printing a total that is quietly 842 activities short, would both be wrong.
    expect(model.entryCount).toBe(total)
    expect(model.totalHours).toBe(total)
    // The MOST RECENT cap rows are the ones itemised, still in ascending order.
    expect(model.rows[0]?.id).toBe("row-00842")
    expect(model.rows[MAX_CERTIFICATE_ENTRIES - 1]?.id).toBe(`row-0${total - 1}`)
  })

  it("accepts caller-supplied whole-ledger aggregates when only a capped page was read", () => {
    const model = buildTranscriptModel({
      holder: HOLDER,
      locale: "en",
      t,
      rows: [row({ id: "a", hours: 2 })],
      totals: { entryCount: 1842, totalHours: 900.5 },
    })
    expect(model.entryCount).toBe(1842)
    expect(model.totalHours).toBe(900.5)
    expect(model.includedCount).toBe(1)
  })

  it("formats row dates per locale in CERTIFICATE_TIME_ZONE", () => {
    const at = "2026-07-27T02:30:00.000Z" // 19:30 on the 26th in Los Angeles
    const labels = (["en", "es", "de", "ko"] as const).map(
      (locale) =>
        buildTranscriptModel({
          holder: HOLDER,
          locale,
          t,
          rows: [row({ id: "a", occurredAt: at })],
        }).rows[0]?.dateLabel,
    )
    expect(labels).toEqual([
      new Intl.DateTimeFormat("en", {
        dateStyle: "medium",
        timeZone: CERTIFICATE_TIME_ZONE,
      }).format(new Date(at)),
      new Intl.DateTimeFormat("es", {
        dateStyle: "medium",
        timeZone: CERTIFICATE_TIME_ZONE,
      }).format(new Date(at)),
      new Intl.DateTimeFormat("de", {
        dateStyle: "medium",
        timeZone: CERTIFICATE_TIME_ZONE,
      }).format(new Date(at)),
      new Intl.DateTimeFormat("ko", {
        dateStyle: "medium",
        timeZone: CERTIFICATE_TIME_ZONE,
      }).format(new Date(at)),
    ])
    // The zone is the whole point: in UTC this evening event would print as the following day.
    expect(labels[0]).toContain("26")
    // Four genuinely different renderings prove full ICU is present, not the small-icu stub.
    expect(new Set(labels).size).toBe(4)
  })

  it("clamps an unsupported locale rather than throwing", () => {
    const model = buildTranscriptModel({
      holder: HOLDER,
      locale: "fr-CA",
      t,
      rows: [row({ id: "a" })],
    })
    expect(model.locale).toBe("en")
  })

  it("CERTIFICATE_TIME_ZONE is a valid IANA zone", () => {
    expect(CERTIFICATE_TIME_ZONE).toBe("America/Los_Angeles")
    expect(() => new Intl.DateTimeFormat("en", { timeZone: CERTIFICATE_TIME_ZONE })).not.toThrow()
  })
})

describe("communitiesLabel", () => {
  it("names up to two communities and counts the rest", () => {
    expect(communitiesLabel([], t)).toBe("")
    expect(communitiesLabel(["Los Angeles"], t)).toBe("Los Angeles")
    expect(communitiesLabel(["Los Angeles", "Santa Monica"], t)).toBe("Los Angeles, Santa Monica")
    expect(communitiesLabel(["Los Angeles", "Santa Monica", "Long Beach", "Inglewood"], t)).toBe(
      "Los Angeles, Santa Monica certificate.summary.more(count=2)",
    )
  })
})

describe("certificateTranslator", () => {
  it("renders every documented key to a non-empty string in all four locales", () => {
    for (const locale of ["en", "es", "de", "ko"]) {
      const translate = certificateTranslator(locale)
      for (const key of CERTIFICATE_MESSAGE_KEYS) {
        expect(
          translate(key, {
            name: "x",
            code: "x",
            ref: "x",
            count: 1,
            shown: 1,
            total: 1,
            page: 1,
            timestamp: "x",
          }),
        ).not.toBe("")
      }
    }
  })
})

describe("ledgerFingerprint", () => {
  const base = () =>
    buildTranscriptModel({
      holder: HOLDER,
      locale: "en",
      t,
      rows: [
        row({ id: "a", hours: 2 }),
        row({ id: "b", hours: 1, occurredAt: "2026-04-04T18:00:00.000Z" }),
      ],
    })

  it("is a stable sha256 hex over the same ledger", () => {
    const fp = ledgerFingerprint(base())
    expect(fp).toMatch(/^[0-9a-f]{64}$/)
    expect(ledgerFingerprint(base())).toBe(fp)
  })

  it("survives the jsonb round trip (the re-render path hashes the same document)", () => {
    const model = base()
    const roundTripped = JSON.parse(JSON.stringify(model)) as typeof model
    expect(ledgerFingerprint(roundTripped)).toBe(ledgerFingerprint(model))
  })

  it("changes when an edited credit changes the hours", () => {
    const edited = buildTranscriptModel({
      holder: HOLDER,
      locale: "en",
      t,
      rows: [
        row({ id: "a", hours: 3 }),
        row({ id: "b", hours: 1, occurredAt: "2026-04-04T18:00:00.000Z" }),
      ],
    })
    expect(ledgerFingerprint(edited)).not.toBe(ledgerFingerprint(base()))
  })

  it("changes on a rename, a handle change and a verification change", () => {
    const fp = ledgerFingerprint(base())
    for (const holder of [
      { ...HOLDER, displayName: "Jane Q. Doe" },
      { ...HOLDER, handle: "janedoe" },
      { ...HOLDER, verified: false },
    ]) {
      const model = { ...base(), holder }
      expect(ledgerFingerprint(model)).not.toBe(fp)
    }
  })

  it("makes an en and a ko transcript over the same ledger two distinct documents", () => {
    const ko = buildTranscriptModel({
      holder: HOLDER,
      locale: "ko",
      t,
      rows: [
        row({ id: "a", hours: 2 }),
        row({ id: "b", hours: 1, occurredAt: "2026-04-04T18:00:00.000Z" }),
      ],
    })
    expect(ledgerFingerprint(ko)).not.toBe(ledgerFingerprint(base()))
  })

  it("ignores the printed labels, which are derived and not asserted content", () => {
    const relabelled = buildTranscriptModel({
      holder: HOLDER,
      locale: "en",
      t: (key) => `~${key}`,
      rows: [
        row({ id: "a", hours: 2 }),
        row({ id: "b", hours: 1, occurredAt: "2026-04-04T18:00:00.000Z" }),
      ],
    })
    expect(ledgerFingerprint(relabelled)).toBe(ledgerFingerprint(base()))
  })
})
