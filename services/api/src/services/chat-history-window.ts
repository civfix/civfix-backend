/**
 * Around-mode history windows (P2 Task 2.4): pure split/merge helpers shared by the chat + dm
 * repositories (drizzle AND in-memory twins) so all history endpoints center a page on a target
 * message the same way.
 *
 * WINDOW SEMANTICS (for `?around=<messageId>`):
 *   - The target's (created_at, id) is the anchor. The window is ceil(limit/2) rows at-or-older than
 *     the anchor (INCLUSIVE — the target row itself is always in the window) + floor(limit/2) rows
 *     strictly newer, re-sorted into the endpoint's normal newest-first order.
 *   - `nextCursor` = the OLDEST id in the window when more older rows exist beyond it (same meaning as
 *     before-mode: pass it as `before` to page older), else null.
 *   - `prevCursor` = the NEWEST id in the window when more rows exist between it and the live head,
 *     else null (the window reaches the head). NOTE: there is no `after` request param today — clients
 *     currently consume prevCursor only as a "there are newer messages" signal (e.g. to show a
 *     jump-to-latest affordance or re-fetch around it); it is NOT a follow-cursor like nextCursor.
 *
 * Both sides fetch limit+1 (olderLimit+1 / newerLimit+1) so has-more is computed correctly on EACH end.
 */

/** How a `limit` splits across the two sides of the anchor (older side includes the target row). */
export interface AroundLimits {
  /** Rows at-or-older than the anchor, INCLUDING the target itself: ceil(limit/2). */
  olderLimit: number
  /** Rows strictly newer than the anchor: floor(limit/2). */
  newerLimit: number
}

export function aroundLimits(limit: number): AroundLimits {
  return { olderLimit: Math.ceil(limit / 2), newerLimit: Math.floor(limit / 2) }
}

export interface AroundWindow<T> {
  /** The merged window in newest-first order (identical ordering to a before-mode page). */
  rows: T[]
  /** More rows exist OLDER than the window (drives nextCursor). */
  hasOlder: boolean
  /** More rows exist NEWER than the window (drives prevCursor). */
  hasNewer: boolean
}

/**
 * Merge the two per-side fetches into one newest-first window.
 * @param olderDesc rows at-or-older than the anchor, newest-first (anchor row first), fetched with
 *   LIMIT olderLimit+1.
 * @param newerAsc rows strictly newer than the anchor, OLDEST-first (ascending — the natural fetch
 *   order when seeking forward from the anchor), fetched with LIMIT newerLimit+1.
 */
export function mergeAroundWindow<T>(
  olderDesc: T[],
  newerAsc: T[],
  { olderLimit, newerLimit }: AroundLimits,
): AroundWindow<T> {
  const hasOlder = olderDesc.length > olderLimit
  const hasNewer = newerAsc.length > newerLimit
  const older = hasOlder ? olderDesc.slice(0, olderLimit) : olderDesc
  const newer = hasNewer ? newerAsc.slice(0, newerLimit) : newerAsc
  // Newer rows arrive ascending; reverse into DESC and prepend so the merged window reads newest-first.
  return { rows: [...newer.slice().reverse(), ...older], hasOlder, hasNewer }
}
