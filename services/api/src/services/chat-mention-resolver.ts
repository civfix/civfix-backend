/**
 * Room-scope rules for resolving chat @-mentions — the SINGLE source consumed by both the WS gateway
 * wiring (send path) and the PATCH /messages route (edit path):
 *
 *   - report rooms resolve only current report_chat_members (D11, P2 2.5): a @mention of a non-member
 *     silently resolves to nothing — no row, no bell;
 *   - dm resolves only the thread PEER (a @mention of anyone else silently drops);
 *   - cleanup resolves only current MEMBERS (capped at THREAD_SIGNAL_MEMBER_CAP);
 *   - group rooms (P4 4.4) resolve only current chat_group_members (uncapped, like report).
 *
 * The user lookup, dm-peer lookup, and member listings are injected so each call site wires its own repo
 * instances; only the scope rules live here. Room kinds added later extend THIS file.
 */

import type { RoomKind, UserMentionDTO } from "@civfix/shared"
import { parseUserMentions } from "./discussion-mentions.js"
import { THREAD_SIGNAL_MEMBER_CAP } from "./cleanup-service.js"
import type { GatewayChatMentions } from "../ws/types.js"

export type ChatMentionRecordSeam = Pick<
  GatewayChatMentions,
  "resolveChatMentions" | "recordChatMentions"
>

export interface RecordChatMentionsInput {
  body: string
  mentionedUserIds: string[]
  authorUserId: string
  kind: RoomKind
  roomId: string
  messageId: string
}

export async function resolveAndRecordChatMentions(
  seam: ChatMentionRecordSeam | undefined,
  input: RecordChatMentionsInput,
): Promise<UserMentionDTO[]> {
  if (!seam) return []
  const handles = parseUserMentions(input.body)
  if (handles.length === 0 && input.mentionedUserIds.length === 0) return []
  try {
    const mentions = await seam.resolveChatMentions({
      handles,
      userIds: input.mentionedUserIds,
      authorUserId: input.authorUserId,
      kind: input.kind,
      roomId: input.roomId,
    })
    if (mentions.length > 0) {
      await seam.recordChatMentions(
        input.messageId,
        mentions.map((m) => m.id),
      )
    }
    return mentions
  } catch {
    return []
  }
}

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
  /** Member ids of a report chat (report_chat_members; uncapped in the repo, like the D-E2 fan-out). */
  listReportChatMemberIds(reportId: string): Promise<string[]>
  /** Member ids of a group room (chat_group_members; P4 4.4). */
  listGroupMemberIds(groupId: string): Promise<string[]>
}

/** Build the seam's `resolveChatMentions` half over the injected lookups. */
export function makeChatMentionResolver(
  deps: ChatMentionResolverDeps,
): GatewayChatMentions["resolveChatMentions"] {
  return async (input) => {
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
    if (input.kind === "report") {
      const memberIds = new Set(await deps.listReportChatMemberIds(input.roomId))
      return resolved.filter((m) => memberIds.has(m.id))
    }
    if (input.kind === "group") {
      const memberIds = new Set(await deps.listGroupMemberIds(input.roomId))
      return resolved.filter((m) => memberIds.has(m.id))
    }
    const memberIds = new Set(
      await deps.listCleanupMemberIds(input.roomId, THREAD_SIGNAL_MEMBER_CAP),
    )
    return resolved.filter((m) => memberIds.has(m.id))
  }
}
