/**
 * Chat reaction service: toggle a viewer's emoji reaction on a CHAT message — the cleanup group chat
 * (chat_messages) OR a 1:1 DM (dm_messages). Mirrors discussion-service.toggleReaction:
 *   - validate the emoji is a bounded ReactionEmoji (422 otherwise);
 *   - validate the viewer is a ROOM MEMBER (cleanup membership for group chat; thread participant + not
 *     blocked-either-way for a DM) — the SAME gates the message-read/edit paths use;
 *   - validate the target message exists in that room (404 otherwise);
 *   - toggle the reaction, re-read the message for the viewer (so the returned DTO carries the recomputed
 *     reactions + `mine`), and return it.
 *
 * Both repos sit behind their existing seams (ChatRepository / DmRepository) so this is unit-testable with
 * the in-memory fakes (no DB). The route wires the broadcast separately (see chat.routes / dm.routes).
 */

import { AppError, ReactionEmojiSchema } from "@civfix/shared"
import type { ChatMessageDTO, ReactionEmoji } from "@civfix/shared"
import type { ChatRepository } from "./chat-repository.drizzle.js"
import type { DmRepository } from "./dm-repository.drizzle.js"

/** A generic 403 for a non-member toggling a reaction (no leak of the room's existence/membership). */
export const CHAT_REACTION_FORBIDDEN = "You can't react in this conversation."

/** Membership probe for a cleanup group chat (cleanup membership == chat membership). */
export type IsCleanupMemberFn = (cleanupId: string, userId: string) => Promise<boolean>

export interface ChatReactionServiceDeps {
  /** The cleanup group-chat repo. Required for toggleCleanupReaction; omit on a DM-only build. */
  chat?: ChatRepository
  /** The DM repo. Required for toggleDmReaction; omit on a cleanup-only build. */
  dm?: DmRepository
  /** Whether `userId` is a member of `cleanupId` (cleanup group chat membership). */
  isCleanupMember?: IsCleanupMemberFn
  /** Whether `userId` is a participant of dm `threadId` (returns the peer id, or null when not a member). */
  dmPeerOf?: (threadId: string, userId: string) => Promise<string | null>
  /** Bidirectional block check, gating a DM reaction (mirrors the dm read/edit gate). */
  isBlockedEitherWay?: (a: string, b: string) => Promise<boolean>
}

export interface ChatReactionService {
  /** Toggle the viewer's reaction on a CLEANUP group-chat message; returns the recomputed message. */
  toggleCleanupReaction(
    cleanupId: string,
    messageId: string,
    userId: string,
    emoji: ReactionEmoji,
  ): Promise<ChatMessageDTO>
  /** Toggle the viewer's reaction on a DM message; returns the recomputed message. */
  toggleDmReaction(
    threadId: string,
    messageId: string,
    userId: string,
    emoji: ReactionEmoji,
  ): Promise<ChatMessageDTO>
}

/** Validate the emoji against the bounded allowlist (a malformed value is a 422, mirroring the route schema). */
function requireEmoji(emoji: ReactionEmoji): ReactionEmoji {
  const parsed = ReactionEmojiSchema.safeParse(emoji)
  if (!parsed.success) throw AppError.validation({ emoji: "Unsupported reaction" })
  return parsed.data
}

/** A repo that reads one message (scoped to its room) + toggles a reaction — the shared shape of both stacks. */
interface ReactionTarget {
  findMessage(roomId: string, messageId: string, viewerUserId: string | null): Promise<ChatMessageDTO | null>
  toggleReaction(messageId: string, userId: string, emoji: ReactionEmoji): Promise<boolean>
}

/**
 * Validate the message exists in the room, toggle the reaction, and re-read so the returned DTO carries the
 * recomputed counts + the viewer's `mine` flags. The caller applies the room-membership gate first
 * (cleanup membership / dm participant-not-blocked); this is only the post-gate body shared by both stacks.
 */
async function toggleAndReread(
  repo: ReactionTarget,
  roomId: string,
  messageId: string,
  userId: string,
  emoji: ReactionEmoji,
): Promise<ChatMessageDTO> {
  // The target must be a live message of THIS room; otherwise 404 (never leak a foreign id).
  if ((await repo.findMessage(roomId, messageId, userId)) === null) {
    throw AppError.notFound("Message not found")
  }
  await repo.toggleReaction(messageId, userId, requireEmoji(emoji))
  const updated = await repo.findMessage(roomId, messageId, userId)
  if (updated === null) throw AppError.notFound("Message not found")
  return updated
}

export function makeChatReactionService(deps: ChatReactionServiceDeps): ChatReactionService {
  return {
    async toggleCleanupReaction(cleanupId, messageId, userId, emoji): Promise<ChatMessageDTO> {
      requireEmoji(emoji)
      const chat = deps.chat
      const isCleanupMember = deps.isCleanupMember
      if (!chat || !isCleanupMember) throw new Error("chat-reaction-service: cleanup deps not wired")
      // Membership gate: cleanup membership == chat membership (same probe the gateway join/send uses).
      if (!(await isCleanupMember(cleanupId, userId))) throw AppError.forbidden(CHAT_REACTION_FORBIDDEN)
      return toggleAndReread(chat, cleanupId, messageId, userId, emoji)
    },

    async toggleDmReaction(threadId, messageId, userId, emoji): Promise<ChatMessageDTO> {
      requireEmoji(emoji)
      const dm = deps.dm
      const dmPeerOf = deps.dmPeerOf
      const isBlockedEitherWay = deps.isBlockedEitherWay
      if (!dm || !dmPeerOf || !isBlockedEitherWay) {
        throw new Error("chat-reaction-service: dm deps not wired")
      }
      // Membership gate: thread participant AND not blocked either way (same gate the dm history/edit
      // routes apply). One generic 403 so "not a participant" and "blocked" are indistinguishable.
      const peer = await dmPeerOf(threadId, userId)
      if (peer === null) throw AppError.forbidden(CHAT_REACTION_FORBIDDEN)
      if (await isBlockedEitherWay(userId, peer)) throw AppError.forbidden(CHAT_REACTION_FORBIDDEN)
      return toggleAndReread(dm, threadId, messageId, userId, emoji)
    },
  }
}
