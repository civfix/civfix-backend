import type { UserMentionDTO } from "@civfix/shared"
import type { Queryable } from "../db/client.js"

export interface MessageMentionRepository {
  // `mentionedUserIds` must already be deduped and self-excluded. Pass the create/edit tx so the
  // delete-then-insert replace is atomic with the message write.
  recordFor(tx: Queryable, messageId: string, mentionedUserIds: string[]): Promise<void>
  loadFor(messageIds: string[]): Promise<Map<string, UserMentionDTO[]>>
}
