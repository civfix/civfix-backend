/**
 * GH#231: the "sent to" notice and the city's status notices follow the reporter's `reportUpdates`
 * setting (D2, D10), and neither Off nor any choice of channels touches the filing's own effects.
 */

import { describe, expect, it } from "vitest"
import type { Setting } from "../helpers/notification-capture.js"
import { J_GEOID } from "../helpers/filings/filing-harness.js"
import {
  ADDRESS,
  REPORTER,
  cityUpdateWorld,
  manualFilingWorld,
  noticeCapture,
  portalRunWorld,
  settleNotices,
} from "../helpers/filings/filing-notices.js"

const OFF: Setting = [false, true, true]
const PUSH_ONLY: Setting = [true, true, false]
const ROW_ONLY: Setting = [true, false, false]
const EMAIL_ONLY: Setting = [true, false, true]

const SENT_TO = "Your report was sent to Los Angeles"
const LOCALES = ["en", "es", "de", "ko"] as const

type Capture = Awaited<ReturnType<typeof noticeCapture>>

function expectNothingSent({ n, emails }: Capture): void {
  expect(n.rows(REPORTER)).toEqual([])
  expect(n.pushesTo(REPORTER)).toEqual([])
  expect(emails()).toEqual([])
  expect(n.warnings).toEqual([])
}

describe("the sent-to notice, recorded by hand", () => {
  it("T1: Off sends nothing and the filing, report, timeline and chat event still happen", async () => {
    const c = await noticeCapture(OFF)
    const w = await manualFilingWorld(c.n)

    await w.recordManual()
    await settleNotices()

    const note = "Filed with Los Angeles · Request 1-555"
    expect(w.h.filings.filings.get(w.filingId)!.status).toBe("submitted")
    expect(w.h.reports.reports.get(w.reportId)!.record.status).toBe("acknowledged")
    expect(w.notes().at(-1)!.note).toBe(note)
    expect(w.h.emitter.events).toHaveLength(1)
    expect(w.h.emitter.events[0]).toMatchObject({ note, kind: "route" })
    await expect(Promise.all(c.n.created)).resolves.toEqual([null])
    expectNothingSent(c)
    expect(w.h.warnings).toEqual([])
  })

  it("T2: on with Push is one row and one push to the reporter, and no email", async () => {
    const c = await noticeCapture(PUSH_ONLY)
    const w = await manualFilingWorld(c.n)

    await w.recordManual()
    await settleNotices()

    expect(c.n.rows(REPORTER)).toMatchObject([
      { type: "report_update", title: SENT_TO, body: null, link: `/reports/${w.reportId}` },
    ])
    expect(c.n.pushesTo(REPORTER)).toHaveLength(1)
    expect(c.emails()).toEqual([])
  })

  it("T3: on with neither channel is the row alone", async () => {
    const c = await noticeCapture(ROW_ONLY)
    const w = await manualFilingWorld(c.n)

    await w.recordManual()
    await settleNotices()

    expect(c.n.rows(REPORTER)).toMatchObject([
      { type: "report_update", title: SENT_TO, body: null, link: `/reports/${w.reportId}` },
    ])
    expect(c.n.pushesTo(REPORTER)).toEqual([])
    expect(c.emails()).toEqual([])
  })

  it("T4: on with Email is one row and one email to the reporter, and no push", async () => {
    const c = await noticeCapture(EMAIL_ONLY)
    const w = await manualFilingWorld(c.n)

    await w.recordManual()
    await settleNotices()

    expect(c.n.rows(REPORTER)).toHaveLength(1)
    expect(c.n.pushesTo(REPORTER)).toEqual([])
    expect(c.emails().map((e) => e.to)).toEqual([ADDRESS])
  })

  it("T5: the email and the row are in the reporter's locale, naming the jurisdiction", async () => {
    const subjects = {
      en: "Your report was sent to Los Angeles",
      es: "Tu reporte fue enviado a Los Angeles",
      de: "Dein Bericht wurde an Los Angeles gesendet",
      ko: "내 제보가 Los Angeles에 전달됐어요",
    }
    for (const locale of LOCALES) {
      const c = await noticeCapture(EMAIL_ONLY, locale)
      const w = await manualFilingWorld(c.n)

      await w.recordManual()
      await settleNotices()

      expect(
        c.emails().map((e) => e.subject),
        locale,
      ).toEqual([subjects[locale]])
      expect(c.n.rows(REPORTER)[0]!.title, locale).toBe(subjects[locale])
    }
  })

  it("T6: with no jurisdiction name the email, the row and the filing note say the city", async () => {
    const subjects = {
      en: "Your report was sent to the city",
      es: "Tu reporte fue enviado a la ciudad",
      de: "Dein Bericht wurde an die Stadt gesendet",
      ko: "내 제보가 시에 전달됐어요",
    }
    for (const locale of LOCALES) {
      const c = await noticeCapture(EMAIL_ONLY, locale)
      const w = await manualFilingWorld(c.n)
      w.h.filings.jurisdictions.delete(J_GEOID)

      await w.recordManual()
      await settleNotices()

      expect(
        c.emails().map((e) => e.subject),
        locale,
      ).toEqual([subjects[locale]])
      expect(c.n.rows(REPORTER)[0]!.title, locale).toBe(subjects[locale])
      expect(w.notes().at(-1)!.note, locale).toBe("Filed with the city · Request 1-555")
    }
  })
})

describe("the sent-to notice, from a portal run", () => {
  it("T7: Off sends nothing and the filing, report, timeline and chat event still happen", async () => {
    const c = await noticeCapture(OFF)
    const w = await portalRunWorld(c.n)

    await expect(w.submit()).resolves.toEqual({ applied: true })
    await settleNotices()

    const note = "Filed with Los Angeles"
    expect(w.h.filings.filings.get(w.filingId)!.status).toBe("submitted")
    expect(w.h.reports.reports.get(w.reportId)!.record.status).toBe("acknowledged")
    expect(w.notes().at(-1)!.note).toBe(note)
    expect(w.h.emitter.events).toHaveLength(1)
    expect(w.h.emitter.events[0]).toMatchObject({ note, kind: "route" })
    expectNothingSent(c)
  })

  it("T8: on with Push is one row and one push, and no email", async () => {
    const c = await noticeCapture(PUSH_ONLY)
    const w = await portalRunWorld(c.n)

    await w.submit()
    await settleNotices()

    expect(c.n.rows(REPORTER).map((r) => r.title)).toEqual([SENT_TO])
    expect(c.n.pushesTo(REPORTER)).toHaveLength(1)
    expect(c.emails()).toEqual([])
  })
})

describe("the city's status notices", () => {
  it("T9: in progress with Off sends nothing and the report, timeline, chat event and message row still move", async () => {
    const c = await noticeCapture(OFF)
    const w = await cityUpdateWorld(c.n)

    await w.send("in_progress")
    await settleNotices()

    const entry = { note: "Los Angeles is working on this request", kind: "status" }
    expect(w.h.reports.reports.get(w.reportId)!.record.status).toBe("in_progress")
    expect(w.notes()).toEqual([entry])
    expect(w.h.emitter.events).toHaveLength(1)
    expect(w.h.emitter.events[0]).toMatchObject(entry)
    expect(w.messageRow().appliedAt).not.toBeNull()
    expectNothingSent(c)
    expect(w.logged).toEqual([])
  })

  it("T10: closed with Off sends nothing and the report, closed date, timeline and chat event still move", async () => {
    const c = await noticeCapture(OFF)
    const w = await cityUpdateWorld(c.n)

    await w.send("closed")
    await settleNotices()

    const entry = { note: "Los Angeles closed the request", kind: "done" }
    expect(w.h.reports.reports.get(w.reportId)!.record.status).toBe("resolved")
    expect(w.h.filings.filings.get(w.filingId)!.cityClosedAt).toBeInstanceOf(Date)
    expect(w.notes()).toEqual([entry])
    expect(w.h.emitter.events).toHaveLength(1)
    expect(w.h.emitter.events[0]).toMatchObject(entry)
    expectNothingSent(c)
    expect(w.logged).toEqual([])
  })

  it("T11: in progress with Push is one row and one push, and no email", async () => {
    const c = await noticeCapture(PUSH_ONLY)
    const w = await cityUpdateWorld(c.n)

    await w.send("in_progress")
    await settleNotices()

    expect(c.n.rows(REPORTER)).toMatchObject([
      {
        type: "report_update",
        title: "Your report is in progress",
        body: "The city is working on your report.",
        link: `/reports/${w.reportId}`,
      },
    ])
    expect(c.n.pushesTo(REPORTER)).toHaveLength(1)
    expect(c.emails()).toEqual([])
  })

  it("T12: closed with Push is one row and one push, and no email", async () => {
    const c = await noticeCapture(PUSH_ONLY)
    const w = await cityUpdateWorld(c.n)

    await w.send("closed")
    await settleNotices()

    expect(c.n.rows(REPORTER)).toMatchObject([
      {
        title: "Your report is resolved",
        body: "Your report has been marked resolved.",
        link: `/reports/${w.reportId}`,
      },
    ])
    expect(c.n.pushesTo(REPORTER)).toHaveLength(1)
    expect(c.emails()).toEqual([])
  })

  it("T13: closed with neither channel is the row alone", async () => {
    const c = await noticeCapture(ROW_ONLY)
    const w = await cityUpdateWorld(c.n)

    await w.send("closed")
    await settleNotices()

    expect(c.n.rows(REPORTER)).toMatchObject([
      {
        title: "Your report is resolved",
        body: "Your report has been marked resolved.",
        link: `/reports/${w.reportId}`,
      },
    ])
    expect(c.n.pushesTo(REPORTER)).toEqual([])
    expect(c.emails()).toEqual([])
  })

  it("T14: closed with Email is one row and one email, and no push", async () => {
    const c = await noticeCapture(EMAIL_ONLY)
    const w = await cityUpdateWorld(c.n)

    await w.send("closed")
    await settleNotices()

    expect(c.n.rows(REPORTER)).toHaveLength(1)
    expect(c.n.pushesTo(REPORTER)).toEqual([])
    expect(c.emails().map((e) => e.subject)).toEqual(["Your report is resolved"])
  })
})
