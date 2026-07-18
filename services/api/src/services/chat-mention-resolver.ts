/**
 * Room-scope rules for resolving chat @-mentions — the SINGLE source consumed by both the WS gateway
 * wiring (send path) and the PATCH /messages route (edit path):
 *
 *   - report rooms are mention-free (always []);
 *   - dm resolves only the thread PEER (a @mention of anyone else silently drops);
 *   - cleanup resolves only current MEMBERS (capped at THREAD_SIGNAL_MEMBER_CAP).
 *
 * The user lookup, dm-peer lookup, and member listing are injected so each call site wires its own repo
 * instances; only the scope rules live here. Room kinds added later (P2/P4 gov rooms) extend THIS file.
 */

import type { UserMentionDTO } from "@civfix/shared"
import { THREAD_SIGNAL_MEMBER_CAP } from "./cleanup-service.js"
import type { GatewayChatMentions } from "../ws/types.js"

export interface ChatMentionResolverDeps {
  /** Handle/id -> mentionable-user lookup (drizzle `resolveMentionTargets` over the shared sql tag). */
  resolveTargets(input: {
    handles: string[]
    userIds: string[]
    authorUserId: string
  }): Promise<UserMentionDTO[]>
  /** The OTHER dm participant, or null when the author is not in the thread. */
  dmPeerOf(threadId: string, userId: string): Promise<string | null>
  /** Member ids of a cleanup, capped (the resolver passes THREAD_SIGNAL_MEMBER_CAP). */
  listCleanupMemberIds(cleanupId: string, cap: number): Promise<string[]>
}

/** Build the seam's `resolveChatMentions` half over the injected lookups. */
export function makeChatMentionResolver(
  deps: ChatMentionResolverDeps,
): GatewayChatMentions["resolveChatMentions"] {
  return async (input) => {
    if (input.kind === "report") return []
    const resolved = await deps.resolveTargets({
      handles: input.handles,
      userIds: input.userIds,
      authorUserId: input.authorUserId,
    })
    if (resolved.length === 0) return resolved
    if (input.kind === "dm") {
      const peer = await deps.dmPeerOf(input.roomId, input.authorUserId)
      return peer !== null ? resolved.filter((m) => m.id === peer) : []
    }
    const memberIds = new Set(await deps.listCleanupMemberIds(input.roomId, THREAD_SIGNAL_MEMBER_CAP))
    return resolved.filter((m) => memberIds.has(m.id))
  }
}
