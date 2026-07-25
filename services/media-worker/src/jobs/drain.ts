/**
 * Bounded page drain for the sweep crons.
 *
 * M10 lesson: a sweep that reaps ONE bounded batch per run is a nibble, not a sweep. When the daily/hourly
 * churn exceeds the batch, the backlog can only ever grow — which is exactly how the orphan sweep let
 * never-committed uploads accumulate in R2 forever. The fix is the same everywhere: keep paging while a
 * page comes back FULL (there is more work), and stop after `maxPages` so one run cannot monopolize the
 * worker or unbound the blast radius of a bad predicate.
 *
 * `handlePage` is responsible for its own per-item error isolation; a throw from either callback
 * propagates so the caller decides whether the whole sweep is degraded.
 */

export interface DrainOptions {
  /** Rows requested per page (the LIMIT handed to fetchPage). */
  pageSize: number
  /** Hard bound on pages drained in one run. */
  maxPages: number
}

/**
 * Fetch + handle pages until a SHORT page arrives (backlog drained) or `maxPages` is reached. Returns the
 * total number of rows seen.
 */
export async function drainPages<T>(
  fetchPage: (limit: number) => Promise<T[]>,
  handlePage: (rows: T[]) => Promise<void> | void,
  opts: DrainOptions,
): Promise<number> {
  let seen = 0
  for (let page = 0; page < opts.maxPages; page++) {
    const rows = await fetchPage(opts.pageSize)
    if (rows.length === 0) break
    seen += rows.length
    await handlePage(rows)
    // A short page means there is nothing left for this cutoff; stop rather than re-querying.
    if (rows.length < opts.pageSize) break
  }
  return seen
}
