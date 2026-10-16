import type { ReactionEmoji, ReactionSummaryDTO } from "@civfix/contract"

export interface MessageReactionRepository {
  toggle(messageId: string, userId: string, emoji: ReactionEmoji): Promise<boolean>
  loadFor(
    messageIds: string[],
    viewerUserId: string | null,
  ): Promise<Map<string, ReactionSummaryDTO[]>>
}
