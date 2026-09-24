/**
 * A sweep that reaps ONE bounded batch per run is a nibble, not a sweep: when the daily/hourly churn
 * exceeds the batch, the backlog can only grow, which is how the orphan sweep once let never-committed
 * uploads accumulate in R2 forever. So keep paging while a page comes back FULL, and stop after
 * `maxPages` so one run cannot monopolize the worker or unbound the blast radius of a bad predicate.
 *
 * `handlePage` is responsible for its own per-item error isolation; a throw from either callback
 * propagates so the caller decides whether the whole sweep is degraded.
 */

export interface DrainOptions {
  pageSize: number
  maxPages: number
}

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
    if (rows.length < opts.pageSize) break
  }
  return seen
}
