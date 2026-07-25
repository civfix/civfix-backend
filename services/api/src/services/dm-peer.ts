/**
 * The DM "who is the other participant" resolution, single-sourced.
 *
 * dm_threads stores the pair as (user_lo, user_hi) with user_lo < user_hi, so every DM gate — history,
 * send, edit, react, pin powers, mention scoping — needs the same ternary over that shape. It had drifted
 * into four hand-written copies; they must agree, because "no peer" is also how each of those gates
 * decides "not a participant".
 */

import type { DmRepository, DmThread } from "./dm-repository.drizzle.js"

/** The OTHER participant of an already-loaded thread, or null when `userId` is not in it. */
export function dmPeerOfThread(thread: DmThread, userId: string): string | null {
  if (thread.userLo === userId) return thread.userHi
  if (thread.userHi === userId) return thread.userLo
  return null
}

/**
 * Thread-loading peer resolver: null when the thread is unknown OR the caller is not a participant (the
 * two cases are deliberately indistinguishable — callers answer one generic 403 for both).
 */
export function makeDmPeerOf(
  dm: Pick<DmRepository, "getThread">,
): (threadId: string, userId: string) => Promise<string | null> {
  return async (threadId, userId) => {
    const thread = await dm.getThread(threadId)
    return thread !== null ? dmPeerOfThread(thread, userId) : null
  }
}
