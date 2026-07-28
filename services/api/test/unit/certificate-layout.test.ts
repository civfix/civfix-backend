/**
 * Pure pagination (DP §8.2). Measured row heights come in as plain numbers, so every page boundary in
 * the transcript is provable without pdfkit, fonts or Docker.
 */

import { describe, expect, it } from "vitest"
import {
  DEFAULT_PAGE_PLAN_OPTIONS as OPTS,
  issuerNeedsNewPage,
  planPages,
  rowsPerPage,
  totalsFitsOnPage,
} from "../../src/services/certificate-layout.js"

const ROW = 22
/** DP §3.4: 17 rows fit below the page-1 furniture, 28 below a continuation header. */
const FIRST_PAGE_ROWS = 17
const CONTINUATION_ROWS = 28

const uniform = (count: number, height = ROW) => Array.from({ length: count }, () => height)

describe("planPages", () => {
  it("always yields a page, even with no rows", () => {
    const [page, ...rest] = planPages([])
    expect(rest).toHaveLength(0)
    expect(page).toEqual({
      page: 1,
      top: OPTS.firstPageTop,
      startIndex: 0,
      endIndex: 0,
      endY: OPTS.firstPageTop,
    })
  })

  it("keeps a single row on page 1", () => {
    const pages = planPages(uniform(1))
    expect(pages).toHaveLength(1)
    expect(pages[0]?.endIndex).toBe(1)
    expect(pages[0]?.endY).toBe(OPTS.firstPageTop + ROW)
  })

  it("fits exactly 17 rows on page 1", () => {
    const pages = planPages(uniform(FIRST_PAGE_ROWS))
    expect(pages).toHaveLength(1)
    expect(pages[0]!.endY).toBeLessThanOrEqual(OPTS.contentFloor)
    expect(pages[0]!.endY + ROW).toBeGreaterThan(OPTS.contentFloor)
  })

  it("overflows the 18th row onto a continuation page", () => {
    const pages = planPages(uniform(FIRST_PAGE_ROWS + 1))
    expect(pages).toHaveLength(2)
    expect(pages[0]).toMatchObject({ page: 1, startIndex: 0, endIndex: FIRST_PAGE_ROWS })
    expect(pages[1]).toMatchObject({
      page: 2,
      top: OPTS.continuationTop,
      startIndex: FIRST_PAGE_ROWS,
      endIndex: FIRST_PAGE_ROWS + 1,
    })
  })

  it("fits 28 rows per continuation page", () => {
    const pages = planPages(uniform(FIRST_PAGE_ROWS + CONTINUATION_ROWS))
    expect(pages).toHaveLength(2)
    expect(pages[1]!.endIndex - pages[1]!.startIndex).toBe(CONTINUATION_ROWS)

    const spill = planPages(uniform(FIRST_PAGE_ROWS + CONTINUATION_ROWS + 1))
    expect(spill).toHaveLength(3)
    expect(spill[2]!.endIndex - spill[2]!.startIndex).toBe(1)
  })

  it("paginates 1000 rows into the expected page count", () => {
    const pages = planPages(uniform(1000))
    // 17 on page 1 + 28 per continuation.
    expect(pages).toHaveLength(1 + Math.ceil((1000 - FIRST_PAGE_ROWS) / CONTINUATION_ROWS))
    expect(pages.at(-1)?.endIndex).toBe(1000)
    // No page may cross the content floor.
    for (const page of pages) expect(page.endY).toBeLessThanOrEqual(OPTS.contentFloor)
  })

  it("pushes a tall two-line Activity row to the next page instead of crossing the floor", () => {
    // 16 normal rows leave room for one more 22pt row but not for a 40pt one.
    const heights = [...uniform(16), 40]
    const pages = planPages(heights)
    expect(pages).toHaveLength(2)
    expect(pages[0]?.endIndex).toBe(16)
    expect(pages[1]?.startIndex).toBe(16)
  })

  it("covers every row exactly once, in order", () => {
    const heights = [30, 22, 48, 22, 22, 60, 22, 22, 22, 90, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22]
    const pages = planPages(heights)
    let cursor = 0
    for (const page of pages) {
      expect(page.startIndex).toBe(cursor)
      cursor = page.endIndex
    }
    expect(cursor).toBe(heights.length)
  })

  it("places a row taller than a whole page alone rather than dropping it", () => {
    const pages = planPages([22, 900, 22])
    expect(pages.map((p) => p.endIndex - p.startIndex)).toEqual([1, 1, 1])
  })
})

describe("totalsFitsOnPage", () => {
  it("is true with room under the last row and false against the floor", () => {
    expect(totalsFitsOnPage(OPTS.contentFloor - OPTS.totalsHeight)).toBe(true)
    expect(totalsFitsOnPage(OPTS.contentFloor - OPTS.totalsHeight + 1)).toBe(false)
  })
})

describe("issuerNeedsNewPage", () => {
  it("forces a fresh page when less than the issuer block remains", () => {
    expect(issuerNeedsNewPage(OPTS.contentFloor - OPTS.issuerHeight)).toBe(false)
    expect(issuerNeedsNewPage(OPTS.contentFloor - OPTS.issuerHeight + 1)).toBe(true)
    expect(issuerNeedsNewPage(OPTS.firstPageTop)).toBe(false)
  })
})

describe("rowsPerPage", () => {
  it("reports the documented capacities", () => {
    expect(rowsPerPage(OPTS.firstPageTop, ROW)).toBe(FIRST_PAGE_ROWS)
    expect(rowsPerPage(OPTS.continuationTop, ROW)).toBe(CONTINUATION_ROWS)
    expect(rowsPerPage(OPTS.continuationTop, 0)).toBe(0)
  })
})
