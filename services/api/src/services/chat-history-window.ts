/**
 * Shared by the chat and dm repositories (drizzle and in-memory) so every `?around=<messageId>` page
 * centers on its target the same way. There is no `after` request param: clients read `prevCursor`
 * only as a "there are newer messages" signal, not as a follow-cursor like `nextCursor`. Both sides
 * fetch limit+1 so has-more is correct on each end.
 */

export interface AroundLimits {
  /** Includes the target row itself, so the target is always in the window. */
  olderLimit: number
  newerLimit: number
}

export function aroundLimits(limit: number): AroundLimits {
  return { olderLimit: Math.ceil(limit / 2), newerLimit: Math.floor(limit / 2) }
}

export interface AroundWindow<T> {
  rows: T[]
  hasOlder: boolean
  hasNewer: boolean
}

/**
 * @param olderDesc rows at-or-older than the anchor, newest-first, fetched with LIMIT olderLimit+1.
 * @param newerAsc rows strictly newer than the anchor, oldest-first (the natural order when seeking
 *   forward from the anchor), fetched with LIMIT newerLimit+1.
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
  return { rows: [...newer.slice().reverse(), ...older], hasOlder, hasNewer }
}
