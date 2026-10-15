import type { ReactionEmoji, ReactionSummaryDTO } from "@civfix/shared"

export interface MessageReactionRepository {
  toggle(messageId: string, userId: string, emoji: ReactionEmoji): Promise<boolean>
  loadFor(
    messageIds: string[],
    viewerUserId: string | null,
  ): Promise<Map<string, ReactionSummaryDTO[]>>
}
