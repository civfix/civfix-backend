
import { AppError, ReactionEmojiSchema } from "@civfix/shared"
import type { ChatMessageDTO, ReactionEmoji } from "@civfix/shared"
import type { ChatRepository } from "./chat-repository.drizzle.js"
import type { DmRepository } from "./dm-repository.drizzle.js"

export const CHAT_REACTION_FORBIDDEN = "You can't react in this conversation."

export type IsCleanupMemberFn = (cleanupId: string, userId: string) => Promise<boolean>

export interface ChatReactionServiceDeps {
  chat?: ChatRepository
  dm?: DmRepository
  isCleanupMember?: IsCleanupMemberFn
  dmPeerOf?: (threadId: string, userId: string) => Promise<string | null>
  isBlockedEitherWay?: (a: string, b: string) => Promise<boolean>
}

export interface ChatReactionService {
  toggleCleanupReaction(
    cleanupId: string,
    messageId: string,
    userId: string,
    emoji: ReactionEmoji,
  ): Promise<ChatMessageDTO>
  toggleDmReaction(
    threadId: string,
    messageId: string,
    userId: string,
    emoji: ReactionEmoji,
  ): Promise<ChatMessageDTO>
  toggleReportReaction(
    reportId: string,
    messageId: string,
    userId: string,
    emoji: ReactionEmoji,
  ): Promise<ChatMessageDTO>
}

function requireEmoji(emoji: ReactionEmoji): ReactionEmoji {
  const parsed = ReactionEmojiSchema.safeParse(emoji)
  if (!parsed.success) throw AppError.validation({ emoji: "Unsupported reaction" })
  return parsed.data
}

interface ReactionTarget {
  findMessage(roomId: string, messageId: string, viewerUserId: string | null): Promise<ChatMessageDTO | null>
  toggleReaction(messageId: string, userId: string, emoji: ReactionEmoji): Promise<boolean>
}

async function toggleAndReread(
  repo: ReactionTarget,
  roomId: string,
  messageId: string,
  userId: string,
  emoji: ReactionEmoji,
): Promise<ChatMessageDTO> {
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
      const peer = await dmPeerOf(threadId, userId)
      if (peer === null) throw AppError.forbidden(CHAT_REACTION_FORBIDDEN)
      if (await isBlockedEitherWay(userId, peer)) throw AppError.forbidden(CHAT_REACTION_FORBIDDEN)
      return toggleAndReread(dm, threadId, messageId, userId, emoji)
    },

    async toggleReportReaction(reportId, messageId, userId, emoji): Promise<ChatMessageDTO> {
      requireEmoji(emoji)
      const chat = deps.chat
      if (!chat) throw new Error("chat-reaction-service: chat deps not wired")
      const reportTarget: ReactionTarget = {
        findMessage: (roomId, mid, viewer) => chat.findReportMessage(roomId, mid, viewer),
        toggleReaction: (mid, uid, e) => chat.toggleReaction(mid, uid, e),
      }
      return toggleAndReread(reportTarget, reportId, messageId, userId, emoji)
    },
  }
}
