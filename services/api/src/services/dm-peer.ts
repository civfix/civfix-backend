// Every DM gate (history, send, edit, react, pin powers, mention scoping) must agree on this, because
// "no peer" is also how each of them decides "not a participant".

import type { DmRepository, DmThread } from "./dm-repository.js"

function dmPeerOfThread(thread: DmThread, userId: string): string | null {
  if (thread.userLo === userId) return thread.userHi
  if (thread.userHi === userId) return thread.userLo
  return null
}

/**
 * An unknown thread and a thread the caller is not in are deliberately indistinguishable: callers answer
 * one generic 403 for both.
 */
export function makeDmPeerOf(
  dm: Pick<DmRepository, "getThread">,
): (threadId: string, userId: string) => Promise<string | null> {
  return async (threadId, userId) => {
    const thread = await dm.getThread(threadId)
    return thread !== null ? dmPeerOfThread(thread, userId) : null
  }
}
