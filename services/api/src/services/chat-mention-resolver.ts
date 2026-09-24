/**
 * Room-scope rules for resolving chat @-mentions — the SINGLE source consumed by both the WS gateway
 * wiring (send path) and the PATCH /messages route (edit path):
 *
 *   - report rooms resolve only current report_chat_members (D11, P2 2.5): a @mention of a non-member
 *     silently resolves to nothing — no row, no bell;
 *   - dm resolves only the thread PEER (a @mention of anyone else silently drops);
 *   - cleanup resolves only current cleanup_members;
 *   - group rooms (P4 4.4) resolve only current chat_group_members.
 *
 * Membership is checked for the resolved users only, never against a capped roster listing, so a member
 * of any seniority stays mentionable. The user lookup, dm-peer lookup, and member filters are injected so
 * each call site wires its own repo instances; only the scope rules live here. Room kinds added later
 * extend THIS file.
 */

import type { RoomKind, UserMentionDTO } from "@civfix/shared"
import { parseUserMentions } from "./discussion-mentions.js"
import type { GatewayChatMentions } from "../ws/types.js"

export type ChatMentionRecordSeam = Pick<
  GatewayChatMentions,
  "resolveChatMentions" | "recordChatMentions" | "logger"
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
  } catch (err) {
    seam.logger?.warn(
      { err, messageId: input.messageId, kind: input.kind, roomId: input.roomId },
      "chat mentions could not be resolved or recorded; sending without them",
    )
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
  /** The cleanup members among `candidateIds`. */
  listCleanupMemberIds(cleanupId: string, candidateIds: string[]): Promise<string[]>
  /** The report chat members (report_chat_members) among `candidateIds`. */
  listReportChatMemberIds(reportId: string, candidateIds: string[]): Promise<string[]>
  /** The group room members (chat_group_members; P4 4.4) among `candidateIds`. */
  listGroupMemberIds(groupId: string, candidateIds: string[]): Promise<string[]>
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
    const candidateIds = resolved.map((m) => m.id)
    const members =
      input.kind === "report"
        ? await deps.listReportChatMemberIds(input.roomId, candidateIds)
        : input.kind === "group"
          ? await deps.listGroupMemberIds(input.roomId, candidateIds)
          : await deps.listCleanupMemberIds(input.roomId, candidateIds)
    const memberIds = new Set(members)
    return resolved.filter((m) => memberIds.has(m.id))
  }
}
