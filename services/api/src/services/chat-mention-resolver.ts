/**
 * The single source of mention scope for both the send and the edit path: a @mention of anyone outside
 * the room (the dm peer, or the room's current members) silently resolves to nothing, so no row and no
 * bell. Membership is checked for the resolved users only, never against a capped roster listing, so a
 * member of any seniority stays mentionable.
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
  resolveTargets(input: {
    handles: string[]
    userIds: string[]
    authorUserId: string
  }): Promise<UserMentionDTO[]>
  /** null when the author is not in the thread. */
  dmPeerOf(threadId: string, userId: string): Promise<string | null>
  listCleanupMemberIds(cleanupId: string, candidateIds: string[]): Promise<string[]>
  listReportChatMemberIds(reportId: string, candidateIds: string[]): Promise<string[]>
  listGroupMemberIds(groupId: string, candidateIds: string[]): Promise<string[]>
}

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
