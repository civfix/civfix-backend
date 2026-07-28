/**
 * PURE pagination for the transcript table (P5). Measured row heights come IN as numbers — the renderer
 * supplies real `doc.heightOfString` values — so this module has no pdfkit dependency and every page
 * boundary is unit-testable.
 *
 * Geometry (DP §3.1/§3.3/§3.4), all in PostScript points on US Letter 612x792:
 *   page 1        first row at y 344 (below the letterhead, holder card, summary tiles, column band)
 *   continuation  first row at y 100 (below the running header + a redrawn column band)
 *   content floor y 730; nothing may cross it, because the footer band starts at y 738
 * At the default 22pt row that is 17 rows on page 1 and 28 per continuation.
 */

export interface PagePlanOptions {
  /** y of the first table row on page 1. */
  firstPageTop: number
  /** y of the first table row on every continuation page. */
  continuationTop: number
  /** Hard content floor; a row may end exactly here but never cross it. */
  contentFloor: number
  /** Height reserved for the totals row (drawn immediately after the last table row). */
  totalsHeight: number
  /** Height of the issuer/attestation block, which is forced onto a fresh page when it does not fit. */
  issuerHeight: number
}

export const DEFAULT_PAGE_PLAN_OPTIONS: PagePlanOptions = {
  firstPageTop: 344,
  continuationTop: 100,
  contentFloor: 730,
  totalsHeight: 34,
  issuerHeight: 180,
}

export interface PagePlan {
  /** 1-based page number. */
  page: number
  /** y of this page's first table row. */
  top: number
  /** Index of the first row on this page, into the `rowHeights` array. */
  startIndex: number
  /** Index AFTER the last row on this page (exclusive), so `endIndex - startIndex` is the row count. */
  endIndex: number
  /** y immediately below this page's last row. Equals `top` on a page with no rows. */
  endY: number
}

/**
 * Split measured row heights into pages. Always returns at least one page, so an empty ledger still
 * yields a well-formed (row-less) document rather than a zero-page one.
 *
 * A row taller than a whole page is placed alone on its page rather than dropped — pdfkit will clip it,
 * which is visible, whereas silently losing a credited activity is not.
 */
export function planPages(
  rowHeights: readonly number[],
  opts: Partial<PagePlanOptions> = {},
): PagePlan[] {
  const { firstPageTop, continuationTop, contentFloor } = { ...DEFAULT_PAGE_PLAN_OPTIONS, ...opts }

  const pages: PagePlan[] = []
  let page = 1
  let top = firstPageTop
  let y = top
  let startIndex = 0

  for (let i = 0; i < rowHeights.length; i++) {
    const height = rowHeights[i] ?? 0
    const isFirstOnPage = i === startIndex
    if (!isFirstOnPage && y + height > contentFloor) {
      pages.push({ page, top, startIndex, endIndex: i, endY: y })
      page += 1
      top = continuationTop
      y = top
      startIndex = i
    }
    y += height
  }

  pages.push({ page, top, startIndex, endIndex: rowHeights.length, endY: y })
  return pages
}

/**
 * Does the totals row still fit under the last table row? When it does not, the renderer starts a
 * continuation page for it — a totals line stranded across a page break reads as a different number.
 */
export function totalsFitsOnPage(endY: number, opts: Partial<PagePlanOptions> = {}): boolean {
  const { contentFloor, totalsHeight } = { ...DEFAULT_PAGE_PLAN_OPTIONS, ...opts }
  return endY + totalsHeight <= contentFloor
}

/** DP §3.5: the issuer/attestation block is forced onto a fresh page when < `issuerHeight` remains. */
export function issuerNeedsNewPage(y: number, opts: Partial<PagePlanOptions> = {}): boolean {
  const { contentFloor, issuerHeight } = { ...DEFAULT_PAGE_PLAN_OPTIONS, ...opts }
  return contentFloor - y < issuerHeight
}

/** Rows that fit on a page whose first row starts at `top`, at a uniform `rowHeight`. */
export function rowsPerPage(
  top: number,
  rowHeight: number,
  opts: Partial<PagePlanOptions> = {},
): number {
  const { contentFloor } = { ...DEFAULT_PAGE_PLAN_OPTIONS, ...opts }
  if (rowHeight <= 0) return 0
  return Math.max(0, Math.floor((contentFloor - top) / rowHeight))
}
